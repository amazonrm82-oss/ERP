-- =============================================================================
-- COL-01: the collection screen. The open debt documents of the business by age of debt, customer and rep, with the total
-- debt and an "overdue" filter (spec 7.5). Plan keys `collection` (the module, every plan) with `documents` and `payments`.
-- =============================================================================
-- * No new rule. The debt is BAL-02's (public.money_allocation_state's balances of active tax invoices, proformas and
--   positive opening balances; a proforma billed by an active tax invoice counts once, on the invoice), overdue and age
--   are BAL-03's (whole days since the due date in the business's zone; overdue from the day after it; buckets current |
--   d1_30 | d31_60 | d61_90 | d91_plus), the customer and the rep are public.report_debt_aging's (the customer: the
--   document's own company, else its contact's, else its deal's, else its contact, else its deal; the rep: the owner of
--   the document's deal, else its contact, else its company, MNY-01's rule), and so is the candidate narrowing before
--   money_allocation_state decides. Keep the `cand` part in step with report_debt_aging (test 264 compares the totals).
-- * public.collection_documents(org, owner, overdue, bucket, customer kind, customer id) (invoker: RLS decides, like the
--   reports). Who: BAL-01's rule (app.can_record_payments) with the three keys, else {"allowed": false}. A partial view
--   (owner's answer, 28 October 2026, COL-01 (3) ב): when the business has any document or payment the caller cannot read
--   (app.business_money_rows, a count only), the answer is {"partial": true} with the documents the caller reads and their
--   balances as the caller's RLS sees them, and NO total of any kind (`totals` and `shown` are null; the screen marks the list
--   "רשימה חלקית" and shows no totals row or bucket amounts). Every amount comes only from rows the caller reads (the whole
--   function runs under the caller's RLS; the count is a number compared, never shown). Owners and admins read every document and
--   payment (BAL-02), so the count, which reads every row under RLS, is skipped for them (measured in the report of COL-01).
--   That shortcut holds only while the read rules of accounting_documents, payments, deals, contacts and companies let an
--   owner or admin read every row; test 264 pins those select policies, and a change there means judging the shortcut again.
--   A platform support session reads as a viewer (app.role_in), so it gets {"allowed": false} (test 264).
--   `totals`: every open document matching the rep and customer filters, with the buckets (the screen's summary and the
--   bucket choices). `shown`: what the overdue and bucket filters keep. `documents`: those rows, most days late first, then
--   largest, at most 500 (`more` says there were more). Each row carries the customer, the rep and whether the customer is
--   held (COL-05: an active hold on the document's contact, the deal's contact, or the customer's company).
-- * `set jit = off`, as on report_debt_aging (021094).
-- Every statement is safe to run twice. No object or row is removed.

create or replace function public.collection_documents(
  p_org uuid,
  p_owner uuid default null,
  p_overdue boolean default false,
  p_bucket text default null,
  p_customer_kind text default null,
  p_customer_id uuid default null
)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
set jit = off
as $$
declare
  v_out jsonb;
  v_today date;
  v_limit constant integer := 500;
  -- COL-01 (3) ב: the caller does not read every money row: documents yes, totals no
  v_partial boolean := false;
begin
  if not app.can_record_payments(p_org)
     or not (app.org_has_feature(p_org, 'collection') and app.org_has_feature(p_org, 'documents')
             and app.org_has_feature(p_org, 'payments')) then
    return jsonb_build_object('allowed', false);
  end if;
  if p_bucket is not null and p_bucket not in ('current', 'd1_30', 'd31_60', 'd61_90', 'd91_plus') then
    raise exception 'unknown age bucket' using errcode = '22023';
  end if;
  if (p_customer_kind is null) <> (p_customer_id is null)
     or (p_customer_kind is not null and p_customer_kind not in ('company', 'contact', 'deal')) then
    raise exception 'unknown customer' using errcode = '22023';
  end if;
  -- BAL-01's partial check for the business (as public.report_debt_aging); a partial view still lists what the caller reads.
  -- Owners and admins read every document and payment (BAL-02), so the count, which reads every row under RLS, is skipped
  if not app.is_admin(p_org) and coalesce(app.business_money_rows(p_org), 0) >
     (select count(*) from public.accounting_documents d where d.organization_id = p_org)
     + (select count(*) from public.payments p where p.organization_id = p_org) then
    v_partial := true;
  end if;

  select (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date into v_today
    from public.organizations o where o.id = p_org;

  with cand as (
    -- public.report_debt_aging's candidates, customer and rep (keep in step)
    select d.id, d.doc_type, d.number, d.doc_date, d.due_date, d.amount_agorot, d.deal_id, d.contact_id, d.company_id,
           coalesce(d.company_id, ct.company_id, dl.company_id) as customer_company,
           coalesce(d.contact_id, dl.contact_id) as customer_contact,
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
  customers as (
    select c.*,
           case when c.customer_company is not null then 'company'
                when c.contact_id is not null then 'contact'
                else 'deal' end as customer_kind,
           coalesce(c.customer_company, c.contact_id, c.deal_id) as customer_id
      from cand c
  ),
  picked as (
    select c.* from customers c
     where p_customer_kind is null or (c.customer_kind = p_customer_kind and c.customer_id = p_customer_id)
  ),
  state as (
    select (x ->> 'id')::uuid as id, coalesce((x ->> 'balance')::bigint, 0) as balance
      from jsonb_array_elements(public.money_allocation_state(p_org, (select coalesce(array_agg(id), '{}'::uuid[]) from picked), '{}'::uuid[])
                                -> 'documents') x
  ),
  debts as (
    select p.*, s.balance, (v_today - p.due_date) as days_late,
           case when p.due_date is null or v_today - p.due_date <= 0 then 'current'
                when v_today - p.due_date <= 30 then 'd1_30'
                when v_today - p.due_date <= 60 then 'd31_60'
                when v_today - p.due_date <= 90 then 'd61_90'
                else 'd91_plus' end as bucket
      from picked p join state s on s.id = p.id
     where s.balance > 0
  ),
  shown as (
    select d.* from debts d
     where (not coalesce(p_overdue, false) or d.days_late >= 1)
       and (p_bucket is null or d.bucket = p_bucket)
  ),
  page as (
    select * from shown order by days_late desc nulls last, balance desc, id limit v_limit
  )
  select jsonb_build_object(
    'allowed', true,
    'partial', v_partial,
    'today', v_today,
    'totals', case when v_partial then null else (select jsonb_build_object(
                 'total', coalesce(sum(d.balance), 0)::bigint,
                 'overdue', coalesce(sum(d.balance) filter (where d.days_late >= 1), 0)::bigint,
                 'documents', count(*),
                 'overdue_documents', count(*) filter (where d.days_late >= 1),
                 'current', coalesce(sum(d.balance) filter (where d.bucket = 'current'), 0)::bigint,
                 'd1_30', coalesce(sum(d.balance) filter (where d.bucket = 'd1_30'), 0)::bigint,
                 'd31_60', coalesce(sum(d.balance) filter (where d.bucket = 'd31_60'), 0)::bigint,
                 'd61_90', coalesce(sum(d.balance) filter (where d.bucket = 'd61_90'), 0)::bigint,
                 'd91_plus', coalesce(sum(d.balance) filter (where d.bucket = 'd91_plus'), 0)::bigint)
                 from debts d) end,
    'shown', case when v_partial then null
                  else (select jsonb_build_object('total', coalesce(sum(s.balance), 0)::bigint, 'documents', count(*)) from shown s) end,
    'more', (select count(*) > v_limit from shown),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', g.id, 'doc_type', g.doc_type, 'number', g.number, 'doc_date', g.doc_date, 'due_date', g.due_date,
               'amount', g.amount_agorot, 'balance', g.balance, 'days_late', g.days_late, 'bucket', g.bucket,
               'deal_id', g.deal_id, 'contact_id', g.contact_id, 'company_id', g.customer_company,
               'customer_kind', g.customer_kind, 'customer_id', g.customer_id,
               'customer_name', case g.customer_kind
                  when 'company' then (select co.name from public.companies co where co.organization_id = p_org and co.id = g.customer_id)
                  when 'contact' then (select ct.full_name from public.contacts ct where ct.organization_id = p_org and ct.id = g.customer_id)
                  else (select dl.name from public.deals dl where dl.organization_id = p_org and dl.id = g.customer_id) end,
               'owner_id', g.owner_id,
               -- COL-05: the customer is held (the document's or its deal's contact, or the customer's company)
               'held', exists (select 1 from public.customer_holds h
                                where h.organization_id = p_org and h.cleared_at is null
                                  and ((g.customer_contact is not null and h.contact_id = g.customer_contact)
                                       or (g.customer_company is not null and h.company_id = g.customer_company))))
               order by g.days_late desc nulls last, g.balance desc, g.id)
        from page g), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$$;
revoke all on function public.collection_documents(uuid, uuid, boolean, text, text, uuid) from public, anon;
grant execute on function public.collection_documents(uuid, uuid, boolean, text, text, uuid) to authenticated;
