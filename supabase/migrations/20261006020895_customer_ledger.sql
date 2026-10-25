-- =============================================================================
-- BAL-01: the customer's ledger ("כספים") on the contact and company pages (spec 7.2). Built as the owner answered on 25
-- October 2026 (DECISIONS.md "כרטסת לקוח"): (1) א, (2) ב, (3) ב, (4) א, (5) א. Plan key `balances` with `documents` and
-- `payments`. A management view, not bookkeeping (the screen says so).
-- =============================================================================
-- * public.customer_ledger(org, contact, company, from, to) (invoker: RLS decides the lines; hint ledger:period for a missing
--   or reversed period). Who may open it (answer 3 ב): owners, admins and managers by role, or a member holding the PRM-01
--   key `record_payments` (= app.can_record_payments); anyone else, and a business without the three keys, gets
--   {"allowed": false}.
-- * Partial view (answer 3 ב): when the customer has any document or payment the caller cannot read (in the period, before it
--   or after it: the opening balance and today's debt and credit depend on all of them), the answer lists the lines the caller
--   reads with `partial: true` and NO balance of any kind: no opening, no running or closing balance, no period totals, no
--   open debt, no credit. Balances only when every row of the customer is readable. The full count comes from
--   app.customer_money_rows (definer; a number only, never ids or amounts; null to anyone who may not open a ledger).
-- * The customer is PAY-02's (the rule of app.money_same_customer and money_allocation_candidates, as PAY-03's credit): the
--   contact, every contact and deal of its company (or of the company passed). The definer count takes the same scope
--   without RLS; the invoker's scope is a subset of it, so a hidden contact, deal, document or payment makes the view partial.
--   Known and accepted (conservative, never a leak): the invoker reaches rows only through the contacts and deals it reads,
--   so a document or payment it does read, on a hidden contact of the company and a readable deal outside it, is counted by
--   the definer only and the view is called partial although nothing of the customer is unreadable. A precise count would
--   need the definer to say which rows (or which hidden contacts) belong to the customer, i.e. ids or a per-row
--   "is this hidden contact in the company" answer, which would tell the caller about a record it may not read; the
--   definer returns a number only. The cost is a partial view (lines without balances) where a full one was possible.
-- * Lines (answer 1 א): a tax invoice is a debit; a proforma is a debit on its own date, and counts as billed only from the
--   date of the active tax invoice that bills it (lead's decision, 26 October 2026; PAY-02 answer 2): the proforma keeps its
--   debit, names the invoice (`invoice_number`) when the invoice is dated within the period's end, and the invoice's line
--   carries only the difference (`proforma_number`; debit = invoice - proforma, or a credit when the proforma was larger),
--   so a past period shows the debt as it stood then and a later one counts the invoice's amount once. An invoice is
--   netted only against an active proforma that is itself a line of this ledger (PAY-02's proforma_id rule is wider than
--   the ledger's scope; in the partial view also one the caller reads, so a hidden proforma's amount never shows) and is
--   dated on or before it. An invoice dated before its proforma keeps its full amount, and the proforma then counts as
--   billed from its own date (no effect), so the closing balance still counts the invoice once.
--   Known and pinned: a proforma of this ledger billed by an invoice OUTSIDE it (the invoice is on a deal or contact of
--   the wider PAY-02 customer only) stays a debit here, while open_debt (money_allocation_state) gives it no balance: its
--   debt now sits on that invoice, in the ledger that holds it. The closing balance and open_debt then differ by it.
--   A tax invoice/receipt is a debit and a credit on the same line
--   (net 0); a credit invoice is a credit; a receipt shows with no amount; a recorded or confirmed payment is a credit.
--   A cancelled document and a failed, refunded or cancelled payment show with no effect (answer 4 א). Date: the document's
--   date, the payment's day; ties by creation, then id.
-- * The period's opening balance is everything before `from`; at most 500 lines are returned, the latest ones, and then the
--   opening is the balance before the first line returned (`truncated`). Totals cover the whole period. Next to them, the
--   customer's open debt today (the balances of money_allocation_state) and its unallocated credit (public.payment_credit),
--   the same numbers as the documents' states and PAY-03's credit.
-- Every statement is safe to run twice. No table, no drops, no row removal.

-- How many documents and payments the customer has in this business, whatever the caller reads. A number only; null unless
-- the caller may open a ledger in this business (app.can_record_payments). The scope mirrors customer_ledger's (keep in step).
create or replace function app.customer_money_rows(p_org uuid, p_contact uuid, p_company uuid)
returns bigint
language sql stable security definer
set search_path = ''
as $$
  with origin_companies as (
    select p_company as company_id where p_company is not null
    union
    select c.company_id from public.contacts c
     where c.organization_id = p_org and c.id = p_contact and c.company_id is not null
  ),
  same_contacts as (
    select p_contact as id where p_contact is not null
    union
    select c.id from public.contacts c where c.organization_id = p_org and c.company_id in (select company_id from origin_companies)
  ),
  same_deals as (
    select d.id from public.deals d where d.organization_id = p_org and d.company_id in (select company_id from origin_companies)
  )
  select case when app.can_record_payments(p_org) then
    (select count(*) from public.accounting_documents d
      where d.organization_id = p_org
        and (d.contact_id in (select id from same_contacts) or d.deal_id in (select id from same_deals)))
    + (select count(*) from public.payments p
        where p.organization_id = p_org
          and (p.contact_id in (select id from same_contacts) or p.deal_id in (select id from same_deals)))
  end
$$;
revoke all on function app.customer_money_rows(uuid, uuid, uuid) from public, anon, authenticated, service_role;
-- customer_ledger is invoker, so the caller runs this
grant execute on function app.customer_money_rows(uuid, uuid, uuid) to authenticated;

create or replace function public.customer_ledger(p_org uuid, p_contact uuid, p_company uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_out jsonb;
  v_partial boolean;
begin
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'a ledger needs a period' using errcode = '22023', hint = 'ledger:period';
  end if;
  if not app.can_record_payments(p_org)
     or not (app.org_has_feature(p_org, 'balances') and app.org_has_feature(p_org, 'documents')
             and app.org_has_feature(p_org, 'payments')) then
    return jsonb_build_object('allowed', false);
  end if;

  -- partial when the customer has a row the caller does not read (answer 3 ב): compare the full count with what RLS shows
  with origin_companies as (
    select p_company as company_id where p_company is not null
    union
    select c.company_id from public.contacts c
     where c.organization_id = p_org and c.id = p_contact and c.company_id is not null
  ),
  same_contacts as (
    select p_contact as id where p_contact is not null
    union
    select c.id from public.contacts c where c.organization_id = p_org and c.company_id in (select company_id from origin_companies)
  ),
  same_deals as (
    select d.id from public.deals d where d.organization_id = p_org and d.company_id in (select company_id from origin_companies)
  )
  select coalesce(app.customer_money_rows(p_org, p_contact, p_company), 0) >
         (select count(*) from public.accounting_documents d
           where d.organization_id = p_org
             and (d.contact_id in (select id from same_contacts) or d.deal_id in (select id from same_deals)))
         + (select count(*) from public.payments p
             where p.organization_id = p_org
               and (p.contact_id in (select id from same_contacts) or p.deal_id in (select id from same_deals)))
    into v_partial;

  if v_partial then
    with origin_companies as (
      select p_company as company_id where p_company is not null
      union
      select c.company_id from public.contacts c
       where c.organization_id = p_org and c.id = p_contact and c.company_id is not null
    ),
    same_contacts as (
      select p_contact as id where p_contact is not null
      union
      select c.id from public.contacts c where c.organization_id = p_org and c.company_id in (select company_id from origin_companies)
    ),
    same_deals as (
      select d.id from public.deals d where d.organization_id = p_org and d.company_id in (select company_id from origin_companies)
    ),
    lines as (
      -- each line's own effect only (no balance), by the rule of the full view below; RLS decides which invoice or proforma
      -- the caller reads (an unread proforma is never netted out of an invoice, so its amount is never shown)
      select 'document'::text as kind, d.id, d.doc_date as on_date, d.created_at, d.doc_type as type, d.number as label,
             d.status, case when i.doc_date <= p_to then i.number end as invoice_number, f.number as proforma_number,
             case when d.status <> 'active' then 0
                  when d.doc_type = 'tax_invoice' then greatest(d.amount_agorot - coalesce(f.amount_agorot, 0), 0)
                  when d.doc_type = 'tax_invoice_receipt' then d.amount_agorot
                  -- billed by an invoice of this ledger dated before it: billed from its own date
                  when d.doc_type = 'proforma' then case when i.in_ledger and i.doc_date < d.doc_date then 0 else d.amount_agorot end
                  else 0 end::bigint as debit,
             case when d.status <> 'active' then 0
                  when d.doc_type in ('tax_invoice_receipt', 'credit_invoice') then d.amount_agorot
                  when d.doc_type = 'tax_invoice' then greatest(coalesce(f.amount_agorot, 0) - d.amount_agorot, 0)
                  else 0 end::bigint as credit,
             d.amount_agorot as amount
        from public.accounting_documents d
        left join lateral (
          select v.number, v.doc_date,
                 (v.contact_id in (select id from same_contacts) or v.deal_id in (select id from same_deals)) is true as in_ledger
            from public.accounting_documents v
           where v.organization_id = p_org and v.proforma_id = d.id and v.status = 'active' and v.doc_type = 'tax_invoice'
             and d.doc_type = 'proforma' and d.status = 'active'
           order by v.doc_date, v.id limit 1) i on true
        left join lateral (
          -- only a proforma that is itself a line of this ledger, dated on or before the invoice
          select v.number, v.amount_agorot from public.accounting_documents v
           where v.organization_id = p_org and v.id = d.proforma_id and v.status = 'active' and v.doc_type = 'proforma'
             and v.doc_date <= d.doc_date
             and (v.contact_id in (select id from same_contacts) or v.deal_id in (select id from same_deals))
             and d.doc_type = 'tax_invoice' and d.status = 'active') f on true
       where d.organization_id = p_org
         and (d.contact_id in (select id from same_contacts) or d.deal_id in (select id from same_deals))
      union all
      select 'payment'::text, p.id, p.paid_on, p.created_at, p.method, p.reference, p.status, null::text, null::text,
             0::bigint,
             case when p.status in ('recorded', 'confirmed') then p.amount_agorot else 0 end::bigint,
             p.amount_agorot
        from public.payments p
       where p.organization_id = p_org
         and (p.contact_id in (select id from same_contacts) or p.deal_id in (select id from same_deals))
    ),
    period as (
      select l.*, row_number() over (order by l.on_date desc, l.created_at desc, l.id desc) as from_end
        from lines l
       where l.on_date between p_from and p_to
    )
    select jsonb_build_object(
      'allowed', true,
      'partial', true,
      'from', p_from,
      'to', p_to,
      'truncated', exists (select 1 from period where from_end > 500),
      'lines', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'kind', s.kind, 'id', s.id, 'date', s.on_date, 'type', s.type, 'label', s.label, 'status', s.status,
                 'invoice_number', s.invoice_number, 'proforma_number', s.proforma_number, 'amount', s.amount, 'debit', s.debit, 'credit', s.credit)
                 order by s.on_date, s.created_at, s.id)
          from period s where s.from_end <= 500), '[]'::jsonb)
    ) into v_out;
    return v_out;
  end if;

  with origin_companies as (
    select p_company as company_id where p_company is not null
    union
    select c.company_id from public.contacts c
     where c.organization_id = p_org and c.id = p_contact and c.company_id is not null
  ),
  same_contacts as (
    select p_contact as id where p_contact is not null
    union
    select c.id from public.contacts c where c.organization_id = p_org and c.company_id in (select company_id from origin_companies)
  ),
  same_deals as (
    select d.id from public.deals d where d.organization_id = p_org and d.company_id in (select company_id from origin_companies)
  ),
  docs as (
    select d.id, d.doc_type, d.number, d.doc_date, d.created_at, d.amount_agorot, d.status, d.proforma_id
      from public.accounting_documents d
     where d.organization_id = p_org
       and (d.contact_id in (select id from same_contacts) or d.deal_id in (select id from same_deals))
  ),
  doc_state as (
    select (x ->> 'id')::uuid as id, x ->> 'state' as state, x ->> 'invoice_number' as invoice_number,
           coalesce((x ->> 'balance')::bigint, 0) as balance
      from jsonb_array_elements(public.money_allocation_state(p_org, (select coalesce(array_agg(id), '{}') from docs), '{}')
                                 -> 'documents') x
  ),
  pays as (
    select p.id, p.method, p.reference, p.paid_on, p.created_at, p.amount_agorot, p.status, public.payment_credit(p) as credit
      from public.payments p
     where p.organization_id = p_org
       and (p.contact_id in (select id from same_contacts) or p.deal_id in (select id from same_deals))
  ),
  lines as (
    -- a proforma is a debit on its own date; the active tax invoice that bills it takes over from the invoice's date: the
    -- invoice's line carries only the difference (BAL-01, lead's decision of 26 October 2026), so a period that ends before
    -- the invoice shows the debt as it stood then, and a later one the invoice's amount once
    select 'document'::text as kind, d.id, d.doc_date as on_date, d.created_at, d.doc_type as type, d.number as label,
           d.status, case when i.doc_date <= p_to then i.number end as invoice_number, f.number as proforma_number,
           case when d.status <> 'active' then 0
                when d.doc_type = 'tax_invoice' then greatest(d.amount_agorot - coalesce(f.amount_agorot, 0), 0)
                when d.doc_type = 'tax_invoice_receipt' then d.amount_agorot
                -- billed by an invoice of this ledger dated before it: billed from its own date
                when d.doc_type = 'proforma' then case when i.in_ledger and i.doc_date < d.doc_date then 0 else d.amount_agorot end
                else 0 end::bigint as debit,
           case when d.status <> 'active' then 0
                when d.doc_type in ('tax_invoice_receipt', 'credit_invoice') then d.amount_agorot
                when d.doc_type = 'tax_invoice' then greatest(coalesce(f.amount_agorot, 0) - d.amount_agorot, 0)
                else 0 end::bigint as credit,
           d.amount_agorot as amount
      from docs d
      left join lateral (
        select v.number, v.doc_date, v.id in (select x.id from docs x) as in_ledger
          from public.accounting_documents v
         where v.organization_id = p_org and v.proforma_id = d.id and v.status = 'active' and v.doc_type = 'tax_invoice'
           and d.doc_type = 'proforma' and d.status = 'active'
         order by v.doc_date, v.id limit 1) i on true
      left join lateral (
        -- only a proforma that is itself a line of this ledger, dated on or before the invoice
        select v.number, v.amount_agorot from docs v
         where v.id = d.proforma_id and v.status = 'active' and v.doc_type = 'proforma' and v.doc_date <= d.doc_date
           and d.doc_type = 'tax_invoice' and d.status = 'active') f on true
    union all
    select 'payment'::text, p.id, p.paid_on, p.created_at, p.method, p.reference, p.status, null::text, null::text,
           0::bigint,
           case when p.status in ('recorded', 'confirmed') then p.amount_agorot else 0 end::bigint,
           p.amount_agorot
      from pays p
  ),
  opening as (
    select coalesce(sum(l.debit - l.credit), 0)::bigint as v from lines l where l.on_date < p_from
  ),
  period as (
    select l.*,
           (select v from opening) + sum(l.debit - l.credit) over (order by l.on_date, l.created_at, l.id
                                                               rows between unbounded preceding and current row) as balance,
           row_number() over (order by l.on_date desc, l.created_at desc, l.id desc) as from_end
      from lines l
     where l.on_date between p_from and p_to
  ),
  shown as (
    select * from period where from_end <= 500
  )
  select jsonb_build_object(
    'allowed', true,
    'partial', false,
    'from', p_from,
    'to', p_to,
    'opening', (select v from opening),
    'shown_opening', coalesce((select s.balance - (s.debit - s.credit) from shown s order by s.from_end desc limit 1),
                              (select v from opening)),
    'truncated', exists (select 1 from period where from_end > 500),
    'debit', coalesce((select sum(debit) from period), 0)::bigint,
    'credit', coalesce((select sum(credit) from period), 0)::bigint,
    'closing', (select v from opening) + coalesce((select sum(debit - credit) from period), 0)::bigint,
    'open_debt', coalesce((select sum(s.balance) from doc_state s), 0)::bigint,
    'credit_balance', coalesce((select sum(p.credit) from pays p), 0)::bigint,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', s.kind, 'id', s.id, 'date', s.on_date, 'type', s.type, 'label', s.label, 'status', s.status,
               'invoice_number', s.invoice_number, 'proforma_number', s.proforma_number, 'amount', s.amount, 'debit', s.debit, 'credit', s.credit,
               'balance', s.balance) order by s.on_date, s.created_at, s.id)
        from shown s), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$$;
revoke all on function public.customer_ledger(uuid, uuid, uuid, date, date) from public, anon;
grant execute on function public.customer_ledger(uuid, uuid, uuid, date, date) to authenticated;
