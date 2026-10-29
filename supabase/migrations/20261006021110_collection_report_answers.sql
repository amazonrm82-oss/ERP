-- =============================================================================
-- COL-06, the owner's answers of 29 October 2026 (docs/DECISIONS.md "ימי גבייה בדוח הגבייה"):
-- (1) (א) collection days run from the document's date to the day it was paid in full, a simple average. That is what
--     021103 built (`average_days` = avg over the documents, unweighted); unchanged. The median stays as an extra figure.
-- (2) (ב) a tax invoice that bills a proforma counts its collection days from the PROFORMA's date, not the invoice's.
--     Only an active proforma (the one money_allocation_state also counts under the invoice); a cancelled proforma leaves
--     the invoice's own date. Days late are unchanged: against the invoice's due date.
-- public.report_collection is redefined from 021103 with that one change (the `closed` step); same signature, answer
-- shape and settings. Keep in step: COL-01's rights, partial rule and rep rule (public.collection_documents), PAY-02's
-- money_allocation_state. Every statement is safe to run twice. No object or row is removed.
-- =============================================================================

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
    -- COL-06 (2) (ב): a tax invoice that bills an active proforma counts its days from the proforma's date (the day the
    -- customer was first asked to pay); days late stay against the invoice's own due date
    select greatest(l.paid_on - coalesce(pf.doc_date, x.doc_date), 0) as days,
           case when x.due_date is not null then greatest(l.paid_on - x.due_date, 0) end as days_late
      from last_day l
      join cand x on x.id = l.id
      join state s on s.id = l.id and s.state = 'paid'
      left join public.accounting_documents pf
             on x.doc_type = 'tax_invoice' and pf.organization_id = p_org and pf.id = x.proforma_id and pf.status = 'active'
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
