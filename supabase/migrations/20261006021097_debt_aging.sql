-- =============================================================================
-- BAL-03: debt aging, 0-30, 31-60, 61-90 and over 90 days, for one customer and for the whole business (spec 7.2). Plan
-- key `balances` with `documents` and `payments`, as BAL-01 and BAL-02.
-- =============================================================================
-- * The debts are BAL-02's (one rule: public.money_allocation_state's balances of active tax invoices, proformas and positive
--   opening balances; a proforma billed by an active tax invoice is 'transferred' and counts once, on the invoice).
-- * Age = whole days since the document's due date, in the business's time zone (owner's answer, 28 October 2026, BAL-03
--   (1) א; DECISIONS.md): a document is overdue from the day after
--   its due date (BAL-02, CLAUDE.md PAY-02), so the buckets are of overdue debt: d1_30 = 1..30 days late ("0 עד 30" of the
--   spec: up to 30 days), d31_60, d61_90, d91_plus = over 90. What is not overdue (due today or later, or with no due date)
--   is its own bucket, `current` ("טרם הגיע מועד התשלום"), never inside 0-30. The buckets add up to the open debt.
-- * One customer: public.customer_debt_summary (BAL-02, redefined here, the same rights, partial rule and answer) adds
--   `aging` {current, d1_30, d31_60, d61_90, d91_plus}.
-- * The whole business: public.report_debt_aging(org, owner) (invoker: RLS decides, CLAUDE.md "Reports"; report key
--   `debt_aging` in public.log_export, redefined here from 021060 with that one key and its refusal). Who: BAL-01's rule
--   (app.can_record_payments with the three keys), else {"allowed": false}. BAL-01's partial rule (owner's answer 3 ב), taken
--   to the business: when the business has any document or payment the caller cannot read (app.business_money_rows, a
--   count only), the answer is {"allowed": true, "partial": true} and no amount of any kind. Owners and admins read every
--   row; a manager or a key holder whose view is narrower sees that it is partial, and the screen says the full report is
--   for owners and admins (owner's answer, 28 October 2026, BAL-03 (2) א).
--   The rows are customers, PAY-02's customer of each document taken once: its company (the document's own company, else
--   its contact's, else its deal's), else its contact, else its deal; per customer the buckets, the total, the overdue part,
--   the number of documents and the oldest overdue due date; most overdue first, then largest, at most 300 rows; the
--   totals cover all of them. With p_owner: the owner of the document's deal, else its contact, else its company (MNY-01's
--   rule). Candidates are narrowed as MNY-01 does before money_allocation_state decides.
-- * Known and accepted:
--   (a) the card (customer_debt_summary) may count a proforma billed by a tax invoice the caller cannot read as still
--       owed, as BAL-01's ledger does (money_allocation_state sees the billing invoice only under the caller's RLS);
--   (b) the report attributes and names customers through the caller's RLS: for a non-admin (whose report is shown only
--       when nothing is hidden) the company of a document is found through the contact or deal the caller reads;
--   (c) the report puts each document under ONE customer (its own company, else its contact's, else its deal's), while
--       the cards and the list columns (BAL-02) count a document under each company it belongs to; a document whose
--       contact and deal belong to different companies counts once here and in both companies' cards.
-- * `set jit = off` on both invoker functions: under RLS the plan's cost estimate passes the JIT thresholds and every call
--   would compile its expressions (021094; JIT is off on the hosted project anyway).
-- Every statement is safe to run twice. No object or row is removed.

-- How many documents and payments the business has, whatever the caller reads. A number only; null unless the caller may
-- open a ledger in this business (app.can_record_payments).
create or replace function app.business_money_rows(p_org uuid)
returns bigint
language sql stable security definer
set search_path = ''
as $$
  select case when app.can_record_payments(p_org) then
    (select count(*) from public.accounting_documents d where d.organization_id = p_org)
    + (select count(*) from public.payments p where p.organization_id = p_org)
  end
$$;
revoke all on function app.business_money_rows(uuid) from public, anon, authenticated, service_role;
-- report_debt_aging is invoker, so the caller runs this
grant execute on function app.business_money_rows(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- One customer: BAL-02's card answer with the aging buckets
-- ----------------------------------------------------------------------------
create or replace function public.customer_debt_summary(p_org uuid, p_contact uuid, p_company uuid)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
set jit = off
as $$
declare
  v_out jsonb;
  v_partial boolean;
  v_today date;
begin
  if not app.can_record_payments(p_org)
     or not (app.org_has_feature(p_org, 'balances') and app.org_has_feature(p_org, 'documents')
             and app.org_has_feature(p_org, 'payments')) then
    return jsonb_build_object('allowed', false);
  end if;

  -- BAL-01's partial rule and scope (public.customer_ledger; keep in step): a row of the customer hidden from the caller
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
             and (d.contact_id in (select id from same_contacts) or d.deal_id in (select id from same_deals)
                  or d.company_id in (select company_id from origin_companies)))
         + (select count(*) from public.payments p
             where p.organization_id = p_org
               and (p.contact_id in (select id from same_contacts) or p.deal_id in (select id from same_deals)))
    into v_partial;
  if v_partial then
    return jsonb_build_object('allowed', true, 'partial', true);
  end if;

  select (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date into v_today
    from public.organizations o where o.id = p_org;

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
    select d.id, d.due_date
      from public.accounting_documents d
     where d.organization_id = p_org
       and d.doc_type in ('tax_invoice', 'proforma', 'opening_balance') and d.status = 'active' and d.amount_agorot > 0
       and (d.contact_id in (select id from same_contacts) or d.deal_id in (select id from same_deals)
            or d.company_id in (select company_id from origin_companies))
  ),
  open_docs as (
    select d.id, d.due_date, s.balance, (v_today - d.due_date) as days_late
      from docs d
      join (select (x ->> 'id')::uuid as id, coalesce((x ->> 'balance')::bigint, 0) as balance
              from jsonb_array_elements(public.money_allocation_state(p_org, (select coalesce(array_agg(id), '{}'::uuid[]) from docs),
                                                                      '{}'::uuid[]) -> 'documents') x) s on s.id = d.id
     where s.balance > 0
  )
  select jsonb_build_object(
    'allowed', true,
    'partial', false,
    'today', v_today,
    'open_debt', coalesce(sum(o.balance), 0)::bigint,
    'open_documents', count(*),
    'overdue_debt', coalesce(sum(o.balance) filter (where o.due_date < v_today), 0)::bigint,
    'overdue_documents', count(*) filter (where o.due_date < v_today),
    'oldest_due_date', min(o.due_date) filter (where o.due_date < v_today),
    -- BAL-03: whole days late in the business's zone; not overdue (due today or later, or no due date) = current
    'aging', jsonb_build_object(
      'current', coalesce(sum(o.balance) filter (where o.days_late is null or o.days_late <= 0), 0)::bigint,
      'd1_30', coalesce(sum(o.balance) filter (where o.days_late between 1 and 30), 0)::bigint,
      'd31_60', coalesce(sum(o.balance) filter (where o.days_late between 31 and 60), 0)::bigint,
      'd61_90', coalesce(sum(o.balance) filter (where o.days_late between 61 and 90), 0)::bigint,
      'd91_plus', coalesce(sum(o.balance) filter (where o.days_late > 90), 0)::bigint))
    into v_out
    from open_docs o;
  return v_out;
end;
$$;
revoke all on function public.customer_debt_summary(uuid, uuid, uuid) from public, anon;
grant execute on function public.customer_debt_summary(uuid, uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The whole business: the aging report
-- ----------------------------------------------------------------------------
create or replace function public.report_debt_aging(p_org uuid, p_owner uuid default null)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
set jit = off
as $$
declare
  v_out jsonb;
  v_today date;
begin
  if not app.can_record_payments(p_org)
     or not (app.org_has_feature(p_org, 'balances') and app.org_has_feature(p_org, 'documents')
             and app.org_has_feature(p_org, 'payments')) then
    return jsonb_build_object('allowed', false);
  end if;
  -- BAL-01's partial rule for the business: a document or payment hidden from the caller means no amount at all
  if coalesce(app.business_money_rows(p_org), 0) >
     (select count(*) from public.accounting_documents d where d.organization_id = p_org)
     + (select count(*) from public.payments p where p.organization_id = p_org) then
    return jsonb_build_object('allowed', true, 'partial', true);
  end if;

  select (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date into v_today
    from public.organizations o where o.id = p_org;

  with cand as (
    select d.id, d.due_date, d.deal_id, d.contact_id, d.company_id,
           coalesce(d.company_id, ct.company_id, dl.company_id) as customer_company,
           coalesce(dl.owner_id, ct.owner_id, co.owner_id) as owner_id
      from public.accounting_documents d
      left join public.deals dl on dl.organization_id = d.organization_id and dl.id = d.deal_id
      left join public.contacts ct on ct.organization_id = d.organization_id and ct.id = d.contact_id
      left join public.companies co on co.organization_id = d.organization_id and co.id = d.company_id
     where d.organization_id = p_org
       and d.status = 'active'
       and d.doc_type in ('tax_invoice', 'proforma', 'opening_balance')
       and d.amount_agorot > 0
       and (p_owner is null or coalesce(dl.owner_id, ct.owner_id, co.owner_id) = p_owner)
       -- candidates only (MNY-01's narrowing): a proforma billed by an active invoice, or a document whose own counted
       -- allocations reach its amount, has no balance; money_allocation_state decides the rest
       and not (d.doc_type = 'proforma'
                and exists (select 1 from public.accounting_documents i
                             where i.organization_id = d.organization_id and i.proforma_id = d.id and i.status = 'active'))
       and coalesce((select sum(a.amount_agorot) from public.payment_allocations a
                      where a.organization_id = d.organization_id and a.document_id = d.id
                        and a.released_at is null and a.removed_at is null), 0)
           + coalesce((select sum(o.amount_agorot) from public.opening_credit_allocations o
                        where o.organization_id = d.organization_id and o.document_id = d.id
                          and o.released_at is null and o.removed_at is null), 0)
           < d.amount_agorot
  ),
  state as (
    select (x ->> 'id')::uuid as id, coalesce((x ->> 'balance')::bigint, 0) as balance
      from jsonb_array_elements(public.money_allocation_state(p_org, (select coalesce(array_agg(id), '{}'::uuid[]) from cand), '{}'::uuid[])
                                -> 'documents') x
  ),
  debts as (
    select c.*, s.balance, (v_today - c.due_date) as days_late,
           case when c.customer_company is not null then 'company'
                when c.contact_id is not null then 'contact'
                else 'deal' end as customer_kind,
           coalesce(c.customer_company, c.contact_id, c.deal_id) as customer_id
      from cand c join state s on s.id = c.id
     where s.balance > 0
  ),
  per_customer as (
    select d.customer_kind, d.customer_id,
           coalesce(sum(d.balance) filter (where d.days_late is null or d.days_late <= 0), 0)::bigint as current,
           coalesce(sum(d.balance) filter (where d.days_late between 1 and 30), 0)::bigint as d1_30,
           coalesce(sum(d.balance) filter (where d.days_late between 31 and 60), 0)::bigint as d31_60,
           coalesce(sum(d.balance) filter (where d.days_late between 61 and 90), 0)::bigint as d61_90,
           coalesce(sum(d.balance) filter (where d.days_late > 90), 0)::bigint as d91_plus,
           sum(d.balance)::bigint as total,
           coalesce(sum(d.balance) filter (where d.days_late >= 1), 0)::bigint as overdue,
           count(*) as documents,
           min(d.due_date) filter (where d.days_late >= 1) as oldest_due_date
      from debts d
     group by d.customer_kind, d.customer_id
  ),
  named as (
    select p.*,
           case p.customer_kind
             when 'company' then (select co.name from public.companies co where co.organization_id = p_org and co.id = p.customer_id)
             when 'contact' then (select ct.full_name from public.contacts ct where ct.organization_id = p_org and ct.id = p.customer_id)
             else (select dl.name from public.deals dl where dl.organization_id = p_org and dl.id = p.customer_id) end as name
      from per_customer p
  )
  select jsonb_build_object(
    'allowed', true,
    'partial', false,
    'today', v_today,
    'totals', (select jsonb_build_object(
                 'current', coalesce(sum(n.current), 0)::bigint,
                 'd1_30', coalesce(sum(n.d1_30), 0)::bigint,
                 'd31_60', coalesce(sum(n.d31_60), 0)::bigint,
                 'd61_90', coalesce(sum(n.d61_90), 0)::bigint,
                 'd91_plus', coalesce(sum(n.d91_plus), 0)::bigint,
                 'total', coalesce(sum(n.total), 0)::bigint,
                 'overdue', coalesce(sum(n.overdue), 0)::bigint,
                 'customers', count(*),
                 'documents', coalesce(sum(n.documents), 0)::bigint)
                 from named n),
    'customers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', z.customer_kind, 'id', z.customer_id, 'name', z.name,
               'current', z.current, 'd1_30', z.d1_30, 'd31_60', z.d31_60, 'd61_90', z.d61_90, 'd91_plus', z.d91_plus,
               'total', z.total, 'overdue', z.overdue, 'documents', z.documents, 'oldest_due_date', z.oldest_due_date)
               order by z.overdue desc, z.total desc, z.name, z.customer_id)
        from (select * from named order by overdue desc, total desc, name, customer_id limit 300) z), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$$;
revoke all on function public.report_debt_aging(uuid, uuid) from public, anon;
grant execute on function public.report_debt_aging(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- public.log_export (021060) learns the report key `debt_aging` (keep equal to src/features/reports/definitions.ts, test 117)
-- ----------------------------------------------------------------------------
create or replace function public.log_export(
  p_org uuid,
  p_kind text,
  p_report text,
  p_rows integer,
  p_format text default 'csv'
) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_role public.membership_role := app.role_in(p_org);
begin
  if p_kind = 'full' then
    if v_role is distinct from 'owner' then
      raise exception 'the full export is for the owner' using errcode = '42501';
    end if;
  elsif p_kind = 'report' then
    if not app.can_export(p_org) then
      raise exception 'export is for owners, admins, team managers and members with the export permission' using errcode = '42501';
    end if;
    -- the report keys of src/features/reports/definitions.ts; keep the two in step
    if p_report is null or p_report not in ('sources', 'funnel', 'response', 'reps', 'activity', 'forecast', 'lost', 'cycle', 'stuck', 'revenue', 'meetings', 'referrals', 'products', 'categories', 'profit', 'quotes', 'source_revenue', 'debt_aging') then
      raise exception 'invalid export' using errcode = '22023';
    end if;
    -- DLI-06: gross profit carries costs
    if p_report = 'profit' and not app.can_view_costs(p_org) then
      raise exception 'the gross profit report is for those who may see costs' using errcode = '42501';
    end if;
    -- QUO-17: the quotes report belongs to the quotes capability
    if p_report = 'quotes' and not app.org_has_feature(p_org, 'quotes') then
      raise exception 'quotes are not in this plan' using errcode = 'P0001', hint = 'feature:quotes';
    end if;
    -- BAL-03: debt aging is for those who open a ledger (BAL-01's rule), with its three keys
    if p_report = 'debt_aging' then
      if not app.can_record_payments(p_org) then
        raise exception 'debt aging is for those who record payments' using errcode = '42501';
      end if;
      if not app.org_has_feature(p_org, 'balances') then
        raise exception 'balances are not in this plan' using errcode = 'P0001', hint = 'feature:balances';
      end if;
      if not (app.org_has_feature(p_org, 'documents') and app.org_has_feature(p_org, 'payments')) then
        raise exception 'documents and payments are not in this plan' using errcode = 'P0001', hint = 'feature:payments';
      end if;
    end if;
  else
    raise exception 'invalid export' using errcode = '22023';
  end if;
  if p_rows is null or p_rows < 0 or p_rows > 10000000 then
    raise exception 'invalid export' using errcode = '22023';
  end if;
  -- RPT-02: the file formats of a report export
  if p_format is null or p_format not in ('csv', 'xlsx') then
    raise exception 'invalid export' using errcode = '22023';
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (
    p_org, auth.uid(), 'export',
    case p_kind when 'full' then 'full_export' else 'reports' end,
    null,
    jsonb_build_object('kind', p_kind, 'rows', p_rows, 'format', case p_kind when 'full' then 'zip' else p_format end)
      || case when p_kind = 'report' then jsonb_build_object('report', p_report) else '{}'::jsonb end
  );
end;
$$;
revoke all on function public.log_export(uuid, text, text, integer, text) from public, anon;
grant execute on function public.log_export(uuid, text, text, integer, text) to authenticated;
