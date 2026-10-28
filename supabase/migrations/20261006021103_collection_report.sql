-- =============================================================================
-- COL-06: the collection report. Money collected by month, by payment method and by rep, and the average collection days
-- (spec 7.5). Debt by age is BAL-03's report (public.report_debt_aging, key `debt_aging`); the screen links to it.
-- Plan keys `collection` (the module, every plan) with `documents` and `payments`, as COL-01.
-- =============================================================================
-- * public.report_collection(org, from date, to date, owner) (invoker: RLS decides what is counted, CLAUDE.md "Reports";
--   report key `collection` in public.log_export, redefined here from 021097 with that one key and its refusal).
--   from/to are calendar days of the business, both inclusive (the report screen's fromDate/toDate); at most 3,660 days.
-- * Who: BAL-01's rule (app.can_record_payments: owners, admins and managers by role, or the PRM-01 key record_payments)
--   with the three keys, else {"allowed": false}. COL-01's partial rule (owner's answer, 28 October 2026, COL-01 (3) ב):
--   when the business has any document or payment the caller cannot read (app.business_money_rows, a count only), the
--   answer is "partial": true with the rows computed from what the caller reads, and NO grand total (`totals` is null).
--   Owners and admins read every document and payment (BAL-02), so the count is skipped for them, as in
--   public.collection_documents (test 264 pins the read policies that shortcut relies on).
-- * Collected = payments in status recorded or confirmed (PAY-01's rule; failed, refunded and cancelled never count) whose
--   paid_on falls in [from, to]. paid_on is already a business date, so a payment on the last day of a month is in that
--   month whatever the hour. `by_month` lists every month of the period (zeros included), `by_method` every method with
--   a payment (codes; the app labels them with PAYMENT_METHOD_LABELS = app.payment_method_label), `by_rep` per rep.
-- * The rep of a payment: COL-01's rule for a document (public.collection_documents, MNY-01's rule: the owner of its deal,
--   else of its contact, else of its own company), which for a payment is the deal's owner, else the contact's, else none
--   (a payment has no company of its own); keep the two in step. A rep the caller cannot see through RLS (the deal or
--   contact unreadable) falls through to the next one, as in report_debt_aging (accepted there, (b)). p_owner keeps only
--   that rep's payments and documents.
-- * Collection days (lead's interim definition, an owner question in the COL-06 report): every active tax invoice or
--   proforma (BAL-02's debt documents; a proforma billed by an active tax invoice counts once, on the invoice, so it is
--   left out here) that is fully paid now (public.money_allocation_state's state 'paid', the one rule) and whose last
--   counted allocation falls in [from, to]. The date of an allocation is its payment's paid_on; the date of an opening
--   credit offset (GAP-12) is the day it was made in the business's zone; a tax invoice also takes the counted
--   allocations of the active proforma it bills (money_allocation_state's rule). Per document: days from its date to that
--   last date (never below 0), and, where it has a due date, days past due (0 when paid on time or early). The answer
--   gives the counts, the average and the median of the days and the average days past due, each null below 5 documents
--   (`min_documents`), like other report rates. Opening balances are left out: their date is the day the balance was
--   carried over, not a sale. In a partial view every figure of `collection_days` but `min_documents` is null: an
--   allocation the caller cannot read could hold the real last date.
-- * Speed (CLAUDE.md "Indexes under RLS"): set-based reads, no per-row function call over the payments. Candidates are
--   narrowed to documents with a counted allocation of a payment paid in the period (or an offset made in it) before
--   money_allocation_state decides, so the read rule of payment_allocations (a check of the document or the payment per
--   row) runs only on their allocations. No new index: one on payments (organization_id, paid_on) made no measurable
--   difference at this size. `set jit = off`, as report_debt_aging (021094), and `set enable_nestloop = off`, as
--   money_allocation_state (021094): under RLS the planner expects a handful of allocations and checked each one's read
--   rule in a nested loop (0.5 s of 0.7 s for a month over 5,000 payments); hashed, 0.2 s.
--   Measured with scripts/perf/collection-report-measure.sql (5,000 payments over a year, 5,000 allocations, the owner):
--   a month, a quarter and a year each about 0.25 s.
-- Every statement is safe to run twice. No object or row is removed.

create or replace function public.report_collection(
  p_org uuid,
  p_from date,
  p_to date,
  p_owner uuid default null
)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
set jit = off
set enable_nestloop = off
as $$
declare
  v_out jsonb;
  v_zone text;
  v_today date;
  v_min constant integer := 5;
  v_partial boolean := false;
begin
  if not app.can_record_payments(p_org)
     or not (app.org_has_feature(p_org, 'collection') and app.org_has_feature(p_org, 'documents')
             and app.org_has_feature(p_org, 'payments')) then
    return jsonb_build_object('allowed', false);
  end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 3660 then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  -- COL-01's partial rule (public.collection_documents; keep in step)
  if not app.is_admin(p_org) and coalesce(app.business_money_rows(p_org), 0) >
     (select count(*) from public.accounting_documents d where d.organization_id = p_org)
     + (select count(*) from public.payments p where p.organization_id = p_org) then
    v_partial := true;
  end if;

  select coalesce(o.timezone, 'Asia/Jerusalem') into v_zone from public.organizations o where o.id = p_org;
  v_zone := coalesce(v_zone, 'Asia/Jerusalem');
  v_today := (now() at time zone v_zone)::date;

  with pay as materialized (
    -- the payments collected in the period, with their rep (COL-01's rule; a payment has no company: keep in step)
    select p.id, p.amount_agorot, p.paid_on, p.method, coalesce(dl.owner_id, ct.owner_id) as owner_id
      from public.payments p
      left join public.deals dl on dl.organization_id = p.organization_id and dl.id = p.deal_id
      left join public.contacts ct on ct.organization_id = p.organization_id and ct.id = p.contact_id
     where p.organization_id = p_org
       and p.status in ('recorded', 'confirmed')
       and p.paid_on >= p_from and p.paid_on <= p_to
  ),
  mine as materialized (
    select * from pay where p_owner is null or owner_id = p_owner
  ),
  months as (
    select m::date as month
      from generate_series(date_trunc('month', p_from::timestamp), date_trunc('month', p_to::timestamp), interval '1 month') m
  ),
  by_month as (
    select m.month, coalesce(sum(x.amount_agorot), 0)::bigint as amount, count(x.id) as payments
      from months m
      left join mine x on date_trunc('month', x.paid_on::timestamp)::date = m.month
     group by m.month
  ),
  by_method as (
    select x.method, sum(x.amount_agorot)::bigint as amount, count(*) as payments from mine x group by x.method
  ),
  by_rep as (
    select x.owner_id, sum(x.amount_agorot)::bigint as amount, count(*) as payments from mine x group by x.owner_id
  ),
  -- collection days. Only a document with a counted allocation dated in the period can have its last one there: those
  -- are found first through the period's payments (and the offsets made in it), so the allocations' read rule (a check of
  -- the document per row) runs on the few allocations of those documents, not on every allocation of the business
  docs as materialized (
    -- the debt documents (not a proforma billed by an active invoice) with the rep of COL-01 (keep in step)
    select d.id, d.doc_type, d.doc_date, d.due_date, d.proforma_id,
           coalesce(dl.owner_id, ct.owner_id, co.owner_id) as owner_id
      from public.accounting_documents d
      left join public.deals dl on dl.organization_id = d.organization_id and dl.id = d.deal_id
      left join public.contacts ct on ct.organization_id = d.organization_id and ct.id = d.contact_id
      left join public.companies co on co.organization_id = d.organization_id and co.id = d.company_id
     where d.organization_id = p_org
       and d.status = 'active'
       and d.doc_type in ('tax_invoice', 'proforma')
       and d.amount_agorot > 0
       and not (d.doc_type = 'proforma'
                and exists (select 1 from public.accounting_documents i
                             where i.organization_id = d.organization_id and i.proforma_id = d.id and i.status = 'active'))
       and (p_owner is null or coalesce(dl.owner_id, ct.owner_id, co.owner_id) = p_owner)
  ),
  touched as materialized (
    select a.document_id
      from public.payment_allocations a
     where a.organization_id = p_org and a.released_at is null and a.removed_at is null
       and a.payment_id in (select x.id from pay x)
    union
    select o.document_id
      from public.opening_credit_allocations o
     where o.organization_id = p_org and o.released_at is null and o.removed_at is null
       and (o.created_at at time zone v_zone)::date between p_from and p_to
  ),
  cand as materialized (
    -- the debt documents touched in the period: by their own allocations, or (a tax invoice) by its billed proforma's
    select x.* from docs x
     where x.id in (select t.document_id from touched t)
        or (x.doc_type = 'tax_invoice' and x.proforma_id in (select t.document_id from touched t))
  ),
  dated as materialized (
    -- every counted allocation of those documents and of the proformas they bill, with its date (the last one decides,
    -- so none is cut at the period's end)
    select a.document_id, p.paid_on as on_day
      from public.payment_allocations a
      join public.payments p on p.organization_id = a.organization_id and p.id = a.payment_id
     where a.organization_id = p_org and a.released_at is null and a.removed_at is null
       and (a.document_id in (select c.id from cand c) or a.document_id in (select c.proforma_id from cand c where c.proforma_id is not null))
    union all
    select o.document_id, (o.created_at at time zone v_zone)::date
      from public.opening_credit_allocations o
     where o.organization_id = p_org and o.released_at is null and o.removed_at is null
       and (o.document_id in (select c.id from cand c) or o.document_id in (select c.proforma_id from cand c where c.proforma_id is not null))
  ),
  dated_doc as (
    -- each counted allocation under the document it pays: its own, and a tax invoice's billed active proforma's
    select t.document_id as doc_id, t.on_day from dated t
    union all
    select i.id, t.on_day
      from dated t
      join cand i on i.doc_type = 'tax_invoice' and i.proforma_id = t.document_id
      join public.accounting_documents p on p.organization_id = p_org and p.id = i.proforma_id and p.status = 'active'
  ),
  last_day as (
    -- the last counted allocation of each debt document, kept when it falls in the period
    select x.id, max(t.on_day) as paid_on
      from cand x
      join dated_doc t on t.doc_id = x.id
     group by x.id
    having max(t.on_day) between p_from and p_to
  ),
  state as (
    select (s ->> 'id')::uuid as id, s ->> 'state' as state
      from jsonb_array_elements(public.money_allocation_state(p_org, (select coalesce(array_agg(id), '{}'::uuid[]) from last_day),
                                                              '{}'::uuid[]) -> 'documents') s
  ),
  closed as (
    select greatest(l.paid_on - x.doc_date, 0) as days,
           case when x.due_date is not null then greatest(l.paid_on - x.due_date, 0) end as days_late
      from last_day l
      join cand x on x.id = l.id
      join state s on s.id = l.id and s.state = 'paid'
  )
  select jsonb_build_object(
    'allowed', true,
    'partial', v_partial,
    'today', v_today,
    'from', p_from,
    'to', p_to,
    'totals', case when v_partial then null
                   else (select jsonb_build_object('amount', coalesce(sum(x.amount_agorot), 0)::bigint, 'payments', count(*)) from mine x) end,
    'by_month', coalesce((select jsonb_agg(jsonb_build_object('month', b.month, 'amount', b.amount, 'payments', b.payments) order by b.month)
                            from by_month b), '[]'::jsonb),
    'by_method', coalesce((select jsonb_agg(jsonb_build_object('method', b.method, 'amount', b.amount, 'payments', b.payments)
                                            order by b.amount desc, b.method)
                             from by_method b), '[]'::jsonb),
    'by_rep', coalesce((select jsonb_agg(jsonb_build_object('owner_id', b.owner_id, 'amount', b.amount, 'payments', b.payments)
                                         order by b.amount desc, b.owner_id nulls last)
                          from by_rep b), '[]'::jsonb),
    'collection_days', case when v_partial then jsonb_build_object(
                          'min_documents', v_min, 'documents', null, 'average_days', null, 'median_days', null,
                          'with_due_date', null, 'average_days_late', null, 'late_documents', null)
                        else (select jsonb_build_object(
                          'min_documents', v_min,
                          'documents', count(*),
                          'average_days', case when count(*) >= v_min then round(avg(c.days), 1) end,
                          'median_days', case when count(*) >= v_min
                                              then round((percentile_cont(0.5) within group (order by c.days))::numeric, 1) end,
                          'with_due_date', count(c.days_late),
                          'average_days_late', case when count(c.days_late) >= v_min then round(avg(c.days_late), 1) end,
                          'late_documents', count(*) filter (where c.days_late > 0))
                          from closed c) end
  ) into v_out;
  return v_out;
end;
$$;
revoke all on function public.report_collection(uuid, date, date, uuid) from public, anon;
grant execute on function public.report_collection(uuid, date, date, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- public.log_export (021097) learns the report key `collection` (keep equal to src/features/reports/definitions.ts, test 117)
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
    if p_report is null or p_report not in ('sources', 'funnel', 'response', 'reps', 'activity', 'forecast', 'lost', 'cycle', 'stuck', 'revenue', 'meetings', 'referrals', 'products', 'categories', 'profit', 'quotes', 'source_revenue', 'debt_aging', 'collection') then
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
    -- COL-06: the collection report is for those who open the collection screen (BAL-01's rule), with its three keys
    if p_report = 'collection' then
      if not app.can_record_payments(p_org) then
        raise exception 'the collection report is for those who record payments' using errcode = '42501';
      end if;
      if not app.org_has_feature(p_org, 'collection') then
        raise exception 'collection is not in this plan' using errcode = 'P0001', hint = 'feature:collection';
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
