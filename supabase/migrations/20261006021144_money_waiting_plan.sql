-- =============================================================================
-- Money waiting without JIT (MNY-01; CI failure of test 257, 2 November 2026)
-- =============================================================================
-- public.report_money_waiting(org, owner) is redefined from its latest body (021089) with ONE added line:
-- `set jit = off`. Signature, security invoker mode, grants and every answer are unchanged.
--
-- Why: with real table statistics (after ANALYZE, as autovacuum keeps them) the planner's cost estimate of the
-- body passes jit_above_cost, jit_optimize_above_cost and jit_inline_above_cost (about 1.25 million: the debts
-- group's candidate scan of accounting_documents with its two correlated allocation sums and the RLS filters of
-- the joined deals, contacts and companies). PostgreSQL then JIT-compiles over 1,000 functions for one call:
-- measured locally (PostgreSQL 16, test 257's bulk case of 3,005 overdue invoices, 3,000 of them paid) JIT took
-- 6.6 s (optimization 3.9 s, emission 2.6 s) of a 6.65 s call whose execution was about 60 ms. Without the
-- ANALYZE the estimates are small, JIT stays off and the call takes about 50 ms, which is why the test passed
-- alone and failed in CI's full run (2.2 s) once autovacuum had analyzed the tables. The same as 021094 did for
-- public.money_allocation_state. JIT is off and unavailable on the hosted project (checked 28 October 2026), so
-- there this changes nothing; a caller's own statement still decides JIT for itself.
-- Safe to run twice: create or replace only.

create or replace function public.report_money_waiting(p_org uuid, p_owner uuid default null)
returns jsonb
language sql stable
set search_path = ''
set jit = off
as $$
  with cur as (
    select (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date as today
      from public.organizations o
     where o.id = p_org
  ), flags as (
    select app.org_has_feature(p_org, 'quotes') as quotes,
           (app.org_has_feature(p_org, 'documents') and app.org_has_feature(p_org, 'payments')
            and app.can_record_payments(p_org)) as debts
  ), vat as (
    select v.rate,
           case when v.rate is null then 'unknown' when v.rate = 0 then 'none' else 'included' end as mode
      from (select app.org_document_vat_rate(p_org, (select today from cur)) as rate where exists (select 1 from cur)) v
  ), won as (
    select count(*) as deals, avg(w.amount_agorot) as average
      from public.deals w
     where w.organization_id = p_org and w.deleted_at is null and w.status = 'won'
       and w.closed_at >= now() - interval '90 days'
  ), l as (
    select l.id, l.full_name, l.company_name, l.phone, l.phone_e164, l.email, l.owner_id, l.created_at
      from public.leads l
      join public.lead_statuses st on st.organization_id = l.organization_id and st.id = l.status_id
     where l.organization_id = p_org and l.deleted_at is null and l.converted_at is null
       and l.import_job_id is null and st.kind = 'open'
       and (p_owner is null or l.owner_id = p_owner)
       and not exists (
         select 1 from public.activities a
          where a.organization_id = l.organization_id and a.lead_id = l.id
            and a.created_by is not null and a.type = any (app.contact_types())
            and not a.is_private)
       and (l.taken_at is null
            or l.owner_id = (select auth.uid())
            or app.membership_role(p_org) in ('owner', 'admin')
            or (app.membership_role(p_org) = 'manager' and l.team_id is not null and app.manages_team(l.team_id)))
  ), avg_value as (
    select case when won.deals >= 5 then app.money_with_vat(round(won.average)::bigint, (select rate from vat)) end as average,
           won.deals
      from won
  ),
  -- quotes sent and not answered; q_rows narrows to p_owner
  q_all as (
    select q.id, q.number_display, q.title, q.status, q.sent_at, q.valid_until, q.net_total_agorot, q.total_agorot,
           q.deal_id, q.contact_id, q.owner_id, q.customer_name,
           case when (select mode from vat) = 'unknown' then q.net_total_agorot else q.total_agorot end as value
      from public.quotes q
     where q.organization_id = p_org
       and (select f.quotes from flags f)
       and q.status in ('sent', 'viewed')
       and q.sent_at is not null
       and q.customer_deleted_at is null
       and (q.valid_until is null or q.valid_until >= (select today from cur))
       and not exists (select 1 from public.quotes n
                        where n.organization_id = q.organization_id and n.previous_id = q.id and n.sent_at is not null)
       and (case when q.deal_id is not null then
              exists (select 1 from public.deals d
                       where d.organization_id = q.organization_id and d.id = q.deal_id and d.deleted_at is null
                         and d.status <> 'lost')
            else
              exists (select 1 from public.contacts k
                       where k.organization_id = q.organization_id and k.id = q.contact_id and k.deleted_at is null)
            end)
  ), q_rows as (
    select * from q_all where p_owner is null or owner_id = p_owner
  ), q_deals as (
    -- only the quotes this view counts hide their deals
    select distinct deal_id from q_rows where deal_id is not null
  ),
  -- the cleanup's stuck and overdue deals in one pass, less the deals counted in quotes
  att as (
    select x.*, app.money_with_vat(x.amount_agorot, (select rate from vat)) as amount
      from (
        select a.id, a.name, a.owner_id, a.pipeline_id, d.stage_id, a.stage_name, s.position as stage_position,
               a.amount_agorot, d.contact_id, d.expected_close_date, a.days_in_stage, a.limit_days, a.last_activity_at,
               a.idle_days, a.stuck,
               (d.expected_close_date is not null and d.expected_close_date < (select today from cur)
                and (d.snoozed_until is null or d.snoozed_until <= (select today from cur))) as overdue
          from app.deal_attention_rows(p_org, null, p_owner, 14, null) a
          join public.deals d on d.organization_id = p_org and d.id = a.id
          join public.stages s on s.organization_id = d.organization_id and s.id = d.stage_id
      ) x
     where (x.stuck or x.overdue)
       and x.id not in (select deal_id from q_deals)
  ),
  -- recurring deals renewing in the next 30 days
  r_rows as (
    select d.id, d.name, d.owner_id, d.status, d.billing_kind,
           app.money_with_vat(d.recurring_amount_agorot, (select rate from vat)) as amount, d.renewal_date, d.contact_id
      from public.deals d
     where d.organization_id = p_org and d.deleted_at is null and d.status in ('open', 'won')
       and d.billing_kind is not null and d.renewal_date is not null
       and d.renewal_date >= (select today from cur) and d.renewal_date <= (select today from cur) + 30
       and (p_owner is null or d.owner_id = p_owner)
       and not exists (select 1 from public.deals f
                        where f.organization_id = d.organization_id and f.previous_deal_id = d.id and f.deleted_at is null)
       and d.id not in (select deal_id from q_deals)
       and d.id not in (select id from att)
  ),
  -- overdue debts
  debt_docs as (
    select d.id, d.doc_type, d.number, d.doc_date, d.due_date, d.amount_agorot, d.deal_id, d.contact_id, d.company_id,
           d.order_id, dl.contact_id as deal_contact_id, coalesce(ct.full_name, co.name, dl.name) as customer_name,
           coalesce(dl.owner_id, ct.owner_id, co.owner_id) as owner_id
      from public.accounting_documents d
      left join public.deals dl on dl.organization_id = d.organization_id and dl.id = d.deal_id
      left join public.contacts ct on ct.organization_id = d.organization_id and ct.id = d.contact_id
      left join public.companies co on co.organization_id = d.organization_id and co.id = d.company_id
     where d.organization_id = p_org
       and (select f.debts from flags f)
       and d.status = 'active'
       and d.doc_type in ('tax_invoice', 'proforma', 'opening_balance')
       and d.amount_agorot > 0
       and d.due_date is not null and d.due_date < (select today from cur)
       and (p_owner is null or coalesce(dl.owner_id, ct.owner_id, co.owner_id) = p_owner)
       -- candidates only: a proforma billed by an active invoice, or a document whose own counted allocations reach
       -- its amount, has no balance (money_allocation_state's rule; proforma payments only lower an invoice further)
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
  ), debt_state as (
    select (x ->> 'id')::uuid as id, coalesce((x ->> 'balance')::bigint, 0) as balance
      from jsonb_array_elements(
             public.money_allocation_state(p_org, (select coalesce(array_agg(id), '{}'::uuid[]) from debt_docs), '{}'::uuid[])
               -> 'documents') x
  ), debts as (
    select d.*, s.balance, ((select today from cur) - d.due_date) as days_overdue
      from debt_docs d join debt_state s on s.id = d.id
     where s.balance > 0
  )
  select jsonb_build_object(
    'today', (select today from cur),
    'vat', (select jsonb_build_object('mode', v.mode, 'rate_bp', v.rate) from vat v),
    'to_close', (select jsonb_build_object('deals', count(*), 'amount', coalesce(sum(amount), 0)) from att),
    'stuck', (select jsonb_build_object('deals', count(*), 'amount', coalesce(sum(amount), 0)) from att where stuck),
    'overdue', (select jsonb_build_object('deals', count(*), 'amount', coalesce(sum(amount), 0)) from att where overdue and not stuck),
    'deals', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', z.id, 'name', z.name, 'owner_id', z.owner_id, 'pipeline_id', z.pipeline_id, 'stage_id', z.stage_id,
               'stage_name', z.stage_name, 'stage_position', z.stage_position, 'amount_agorot', z.amount,
               'contact_id', z.contact_id, 'expected_close_date', z.expected_close_date, 'days_in_stage', z.days_in_stage,
               'limit_days', z.limit_days, 'last_activity_at', z.last_activity_at, 'idle_days', z.idle_days,
               'stuck', z.stuck, 'overdue', z.overdue)
               order by z.last_activity_at asc nulls first, z.days_in_stage desc, z.amount_agorot desc, z.id)
        from (select * from att
               order by last_activity_at asc nulls first, days_in_stage desc, amount_agorot desc, id
               limit 300) z), '[]'::jsonb),
    'estimate', (
      select jsonb_build_object(
               'leads', (select count(*) from l),
               'won_deals', av.deals,
               'average', av.average,
               'amount', av.average * (select count(*) from l),
               'days', 90,
               'min_deals', 5)
        from avg_value av),
    'leads', coalesce((
      select jsonb_agg(z order by z.created_at desc, z.id)
        from (select * from l order by l.created_at desc, l.id limit 100) z), '[]'::jsonb),
    'quotes', case when (select f.quotes from flags f) then jsonb_build_object(
      'count', (select count(*) from q_rows),
      'amount', (select coalesce(sum(value), 0) from q_rows),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', z.id, 'number', z.number_display, 'title', z.title, 'status', z.status, 'sent_at', z.sent_at,
                 'valid_until', z.valid_until, 'amount_agorot', z.value, 'net_agorot', z.net_total_agorot,
                 'total_agorot', z.total_agorot, 'deal_id', z.deal_id, 'contact_id', z.contact_id, 'owner_id', z.owner_id,
                 'customer_name', z.customer_name)
                 order by z.sent_at, z.id)
          from (select * from q_rows order by sent_at, id limit 300) z), '[]'::jsonb)) end,
    'debts', case when (select f.debts from flags f) then jsonb_build_object(
      'count', (select count(*) from debts),
      'amount', (select coalesce(sum(balance), 0) from debts),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', z.id, 'doc_type', z.doc_type, 'number', z.number, 'doc_date', z.doc_date, 'due_date', z.due_date,
                 'days_overdue', z.days_overdue, 'amount_agorot', z.amount_agorot, 'balance', z.balance,
                 'deal_id', z.deal_id, 'contact_id', z.contact_id, 'company_id', z.company_id, 'order_id', z.order_id,
                 'deal_contact_id', z.deal_contact_id, 'owner_id', z.owner_id, 'customer_name', z.customer_name)
                 order by z.due_date, z.id)
          from (select * from debts order by due_date, id limit 300) z), '[]'::jsonb)) end,
    'renewals', jsonb_build_object(
      'count', (select count(*) from r_rows),
      'amount', (select coalesce(sum(amount), 0) from r_rows),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', z.id, 'name', z.name, 'owner_id', z.owner_id, 'status', z.status, 'billing_kind', z.billing_kind,
                 'amount_agorot', z.amount, 'renewal_date', z.renewal_date, 'contact_id', z.contact_id)
                 order by z.renewal_date, z.id)
          from (select * from r_rows order by renewal_date, id limit 300) z), '[]'::jsonb)))
    from cur;
$$;

revoke all on function public.report_money_waiting(uuid, uuid) from public, anon;
grant execute on function public.report_money_waiting(uuid, uuid) to authenticated;
