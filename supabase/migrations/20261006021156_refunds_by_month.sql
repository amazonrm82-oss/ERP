-- =============================================================================
-- PAY-08 follow-up: refunds counted in the month they were made (owner's answer (81) ב, 3 November 2026)
-- =============================================================================
-- In the collection report (COL-06) and in collection goal progress (GOL-01, metric 'collected') a refund is its own
-- NEGATIVE row in the period of its refunded_on (a date: the business's months), and the payment it returns money from
-- stays IN FULL in the period of its paid_on. 021154 took a payment's active refunds off the payment itself; that is
-- reverted here for these two readers only. Every other reader of a payment's amount (payment_credit,
-- money_allocation_state, the allocation cap, customer_ledger, order money, statement_public / statement_staff_view)
-- keeps 021154's rule: for the customer's balance a refund still reduces what the payment counts.
-- * Which payments count in full: recorded or confirmed, as before, and also status 'refunded' WHILE the payment has an
--   active refund record (PAY-08 sets 'refunded' when its refunds reach the full amount; cancelling them puts the status
--   back). A 'refunded' status set by hand with no refund record keeps its old (legacy) meaning: not counted at all.
-- * Which refunds count: active (a cancelled refund counts nowhere), refunded_on in the period, of a payment the caller
--   reads whose status is recorded, confirmed or refunded (an active refund exists only on such a payment: PAY-08 refuses
--   a refund on any other status and refuses failing or cancelling a payment while it has one), wherever the payment's own
--   day falls (a refund in the period of a payment from before it counts in the period).
-- * report_collection: by_month, by_method, by_rep and totals keep `amount` and `payments` (the payments, in full) and gain
--   `refunds` (agorot refunded), `refund_count` and `net` (amount - refunds). A refund goes under its OWN method (the way
--   the money went back) and under its PAYMENT's rep (COL-01's rule: the deal's owner, else the contact's); the rep filter
--   follows the payment's rep. A month, method or rep with refunds only is listed with amount 0. COL-01's partial rule is
--   unchanged (totals null when partial; refunds of payments the caller cannot read are never seen, as those payments).
--   The collection days (allocations) are unchanged: only recorded/confirmed payments find the touched documents, as before.
-- * report_goal_progress ('collected'): actual = the counted payments of the period in full minus the active refunds made
--   in it, by the payment's rep and team; the cheque rule ((17) ג) applies to the refund's payment. A refund row is one in
--   n, and app.goal_payments_counted (definer, a count only) counts the same refund rows, so a goal is still left out when
--   the caller cannot read every counted row (keep the two in step).
-- Redefined from their latest bodies (report_collection and report_goal_progress of 021154, app.goal_payments_counted of
-- 021111); same signatures and settings. Every statement is safe to run twice. No drops, no row removal.

create or replace function app.goal_payments_counted(p_org uuid, p_goal uuid) returns bigint
language sql stable security definer
set search_path = ''
as $$
  with g as (
    select g.scope, g.user_id, g.team_id, g.period_start,
           (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date as today,
           (g.period_start + case g.period when 'month' then interval '1 month'
                                           when 'quarter' then interval '3 months'
                                           else interval '1 year' end)::date as period_end
      from public.goals g
      join public.organizations o on o.id = g.organization_id
     where g.organization_id = p_org and g.id = p_goal and g.metric = 'collected'
       and (app.is_member(p_org) or app.support_session(p_org))
       -- GOL-01 (16) (ב): an actual only for those who record payments, (15) (ב) with the three keys
       and app.can_record_payments(p_org)
       and app.org_has_feature(p_org, 'payments') and app.org_has_feature(p_org, 'documents')
       and app.org_has_feature(p_org, 'collection')
       and (app.is_admin(p_org)
            or g.scope = 'org'
            or app.support_session(p_org)
            or (g.scope = 'user' and g.user_id = auth.uid())
            or (g.scope = 'user' and app.goals_manages_user(p_org, g.user_id))
            or (g.scope = 'team' and (app.in_team(g.team_id) or app.goals_manages_team(p_org, g.team_id))))
  ), tree as (
    with recursive t (team_id, depth) as (
      select g.team_id, 1 from g where g.scope = 'team'
      union all
      select c.id, t.depth + 1
        from t join public.teams c on c.organization_id = p_org and c.parent_team_id = t.team_id
       where t.depth < 10
    )
    select distinct t.team_id from t
  )
  select case when exists (select 1 from g) then (
    select count(*)
      from g
      join public.payments p on p.organization_id = p_org
                            -- PAY-08 (81) ב: a payment refunded in full by its refunds counts in full too (keep in step
                            -- with report_goal_progress)
                            and (p.status in ('recorded', 'confirmed')
                                 or (p.status = 'refunded'
                                     and exists (select 1 from public.payment_refunds r
                                                  where r.organization_id = p.organization_id and r.payment_id = p.id
                                                    and r.status = 'active')))
                            and p.paid_on >= g.period_start and p.paid_on < g.period_end
                            -- GOL-01 (17) (ג): a cheque counts once cleared or its due date has come (the business's today);
                            -- a bounced one never (its payment is failed too). Keep in step with report_goal_progress
                            and (p.cheque_status is null or p.cheque_status = 'cleared'
                                 or (p.cheque_status <> 'bounced' and p.cheque_due_date <= g.today))
      left join public.deals dl on dl.organization_id = p.organization_id and dl.id = p.deal_id
      left join public.contacts ct on ct.organization_id = p.organization_id and ct.id = p.contact_id
     where g.scope = 'org'
        or (g.scope = 'user' and coalesce(dl.owner_id, ct.owner_id) = g.user_id)
        or (g.scope = 'team' and coalesce(dl.team_id, ct.team_id) in (select tree.team_id from tree))
  ) + (
    -- PAY-08 (81) ב: and every active refund made in the period, of a payment that counts, under its payment's rep and team
    select count(*)
      from g
      join public.payment_refunds r on r.organization_id = p_org and r.status = 'active'
                                   and r.refunded_on >= g.period_start and r.refunded_on < g.period_end
      join public.payments p on p.organization_id = r.organization_id and p.id = r.payment_id
                            and p.status in ('recorded', 'confirmed', 'refunded')
                            and (p.cheque_status is null or p.cheque_status = 'cleared'
                                 or (p.cheque_status <> 'bounced' and p.cheque_due_date <= g.today))
      left join public.deals dl on dl.organization_id = p.organization_id and dl.id = p.deal_id
      left join public.contacts ct on ct.organization_id = p.organization_id and ct.id = p.contact_id
     where g.scope = 'org'
        or (g.scope = 'user' and coalesce(dl.owner_id, ct.owner_id) = g.user_id)
        or (g.scope = 'team' and coalesce(dl.team_id, ct.team_id) in (select tree.team_id from tree))
  ) end
$$;
revoke all on function app.goal_payments_counted(uuid, uuid) from public, anon, service_role;
-- report_goal_progress is invoker, so the caller runs this
grant execute on function app.goal_payments_counted(uuid, uuid) to authenticated;

CREATE OR REPLACE FUNCTION public.report_collection(p_org uuid, p_from date, p_to date, p_owner uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET jit TO 'off'
 SET enable_nestloop TO 'off'
AS $function$
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
    -- PAY-08 (owner's answer (81) ב): a payment counts IN FULL in its own month; its refunds count against the months they
    -- were made in (ref below). A payment refunded in full by its refunds has status 'refunded' and still counts in full
    -- here; a 'refunded' status set by hand with no active refund record (the legacy meaning) stays out, as before
    select p.id, p.amount_agorot, p.paid_on, p.method, p.status, coalesce(dl.owner_id, ct.owner_id) as owner_id
      from public.payments p
      left join public.deals dl on dl.organization_id = p.organization_id and dl.id = p.deal_id
      left join public.contacts ct on ct.organization_id = p.organization_id and ct.id = p.contact_id
     where p.organization_id = p_org
       and (p.status in ('recorded', 'confirmed')
            or (p.status = 'refunded'
                and exists (select 1 from public.payment_refunds r
                             where r.organization_id = p.organization_id and r.payment_id = p.id and r.status = 'active')))
       and p.paid_on >= p_from and p.paid_on <= p_to
  ),
  mine as materialized (
    select * from pay where p_owner is null or owner_id = p_owner
  ),
  ref as materialized (
    -- PAY-08 (81) ב: the active refunds made in the period (refunded_on), of payments the caller reads that count (recorded,
    -- confirmed, or refunded in full by their refunds: an active refund exists only on such a payment), whatever the
    -- payment's own day; by the refund's own method and the payment's rep (COL-01's rule, keep in step)
    select r.id, r.amount_agorot, r.refunded_on, r.method, coalesce(dl.owner_id, ct.owner_id) as owner_id
      from public.payment_refunds r
      join public.payments p on p.organization_id = r.organization_id and p.id = r.payment_id
      left join public.deals dl on dl.organization_id = p.organization_id and dl.id = p.deal_id
      left join public.contacts ct on ct.organization_id = p.organization_id and ct.id = p.contact_id
     where r.organization_id = p_org
       and r.status = 'active'
       and p.status in ('recorded', 'confirmed', 'refunded')
       and r.refunded_on >= p_from and r.refunded_on <= p_to
       and (p_owner is null or coalesce(dl.owner_id, ct.owner_id) = p_owner)
  ),
  flows as (
    -- one row per payment (+) and per refund (-), so a month, method or rep with only refunds is still listed
    select x.paid_on as on_day, x.method, x.owner_id, x.amount_agorot as amount, 1 as payments, 0::bigint as refunds, 0 as refund_count
      from mine x
    union all
    select r.refunded_on, r.method, r.owner_id, 0::bigint, 0, r.amount_agorot, 1
      from ref r
  ),
  months as (
    select m::date as month
      from generate_series(date_trunc('month', p_from::timestamp), date_trunc('month', p_to::timestamp), interval '1 month') m
  ),
  by_month as (
    select m.month, coalesce(sum(x.amount), 0)::bigint as amount, coalesce(sum(x.payments), 0)::bigint as payments,
           coalesce(sum(x.refunds), 0)::bigint as refunds, coalesce(sum(x.refund_count), 0)::bigint as refund_count
      from months m
      left join flows x on date_trunc('month', x.on_day::timestamp)::date = m.month
     group by m.month
  ),
  by_method as (
    select x.method, sum(x.amount)::bigint as amount, sum(x.payments)::bigint as payments,
           sum(x.refunds)::bigint as refunds, sum(x.refund_count)::bigint as refund_count
      from flows x group by x.method
  ),
  by_rep as (
    select x.owner_id, sum(x.amount)::bigint as amount, sum(x.payments)::bigint as payments,
           sum(x.refunds)::bigint as refunds, sum(x.refund_count)::bigint as refund_count
      from flows x group by x.owner_id
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
       and a.payment_id in (select x.id from pay x where x.status in ('recorded', 'confirmed'))
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
                   else (select jsonb_build_object('amount', coalesce(sum(x.amount), 0)::bigint,
                                                   'payments', coalesce(sum(x.payments), 0)::bigint,
                                                   'refunds', coalesce(sum(x.refunds), 0)::bigint,
                                                   'refund_count', coalesce(sum(x.refund_count), 0)::bigint,
                                                   'net', (coalesce(sum(x.amount), 0) - coalesce(sum(x.refunds), 0))::bigint)
                           from flows x) end,
    'by_month', coalesce((select jsonb_agg(jsonb_build_object('month', b.month, 'amount', b.amount, 'payments', b.payments,
                                                              'refunds', b.refunds, 'refund_count', b.refund_count,
                                                              'net', b.amount - b.refunds) order by b.month)
                            from by_month b), '[]'::jsonb),
    'by_method', coalesce((select jsonb_agg(jsonb_build_object('method', b.method, 'amount', b.amount, 'payments', b.payments,
                                                               'refunds', b.refunds, 'refund_count', b.refund_count,
                                                               'net', b.amount - b.refunds)
                                            order by b.amount desc, b.refunds desc, b.method)
                             from by_method b), '[]'::jsonb),
    'by_rep', coalesce((select jsonb_agg(jsonb_build_object('owner_id', b.owner_id, 'amount', b.amount, 'payments', b.payments,
                                                            'refunds', b.refunds, 'refund_count', b.refund_count,
                                                            'net', b.amount - b.refunds)
                                         order by b.amount desc, b.refunds desc, b.owner_id nulls last)
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
$function$;


CREATE OR REPLACE FUNCTION public.report_goal_progress(p_org uuid, p_period text DEFAULT NULL::text, p_period_start date DEFAULT NULL::date, p_user uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with org as (
    select coalesce(o.timezone, 'Asia/Jerusalem') as tz, o.record_visibility::text as visibility,
           (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date as today
      from public.organizations o
     where o.id = p_org
  ), g as (
    select g.id, g.scope, g.user_id, g.team_id, g.period, g.period_start, g.metric, g.target,
           (g.period_start::timestamp at time zone org.tz) as t_from,
           ((g.period_start + case g.period when 'month' then interval '1 month'
                                            when 'quarter' then interval '3 months'
                                            else interval '1 year' end)::timestamp at time zone org.tz) as t_to
      from public.goals g
      cross join org
     where g.organization_id = p_org
       and (p_user is null or (g.scope = 'user' and g.user_id = p_user))
       and case when p_period is not null or p_period_start is not null
                then g.period = p_period and g.period_start = p_period_start
                else g.period_start <= org.today
                     and org.today < g.period_start + case g.period when 'month' then interval '1 month'
                                                                    when 'quarter' then interval '3 months'
                                                                    else interval '1 year' end
           end
       -- GOL-01 collection: only while the plan holds payments, documents and collection ((15) ב), and only for those
       -- who record payments ((16) ב: COL-01's rule; for anyone else the goal is left out, as COL-01 answers them
       -- {"allowed": false}; the goal's target stays visible on the goals grid per goals_select)
       and (g.metric <> 'collected'
            or (app.org_has_feature(p_org, 'payments') and app.org_has_feature(p_org, 'documents')
                and app.org_has_feature(p_org, 'collection') and app.can_record_payments(p_org)))
  ), windows as (
    select distinct g.period, g.period_start, g.t_from, g.t_to from g
  ), contacted as (
    -- leads with a contact entry inside a goal's window first; their first entry ever is then
    -- looked up for those leads only
    select distinct a.lead_id
      from windows w
      join public.activities a on a.organization_id = p_org and a.lead_id is not null
                              and a.occurred_at >= w.t_from and a.occurred_at < w.t_to
     where a.created_by is not null and a.type = any (app.contact_types()) and not a.is_private
       and a.occurred_at <= now() + interval '5 minutes'
       and exists (select 1 from g where g.metric = 'leads_handled')
  ), first_contact as (
    select a.lead_id, min(a.occurred_at) as at
      from public.activities a
     where a.organization_id = p_org and a.lead_id in (select c.lead_id from contacted c)
       and a.created_by is not null and a.type = any (app.contact_types()) and not a.is_private
       and a.occurred_at <= now() + interval '5 minutes'
     group by a.lead_id
  ), pay_rows as (
    -- GOL-01 collection: payments recorded or confirmed with paid_on in the period, a cheque only once cleared or due
    -- (owner's answer (17) ג), by rep
    -- (the deal's owner, else the contact's) and team (the deal's, else the contact's), as the caller reads them.
    -- PAY-08 (owner's answer (81) ב): a payment counts IN FULL in its own period, also one refunded in full by its refunds
    -- (status 'refunded' with an active refund; a 'refunded' status set by hand with no refund record stays out); each
    -- active refund counts NEGATIVE in the period of its refunded_on, under its payment's rep and team and its payment's
    -- cheque rule. Every row (payment or refund) is one in n (keep in step with app.goal_payments_counted)
    select w.period, w.period_start, coalesce(dl.owner_id, ct.owner_id) as user_id, coalesce(dl.team_id, ct.team_id) as team_id,
           p.amount_agorot::numeric as value
      from windows w
      cross join org
      join public.payments p on p.organization_id = p_org
                            and (p.status in ('recorded', 'confirmed')
                                 or (p.status = 'refunded'
                                     and exists (select 1 from public.payment_refunds r
                                                  where r.organization_id = p.organization_id and r.payment_id = p.id
                                                    and r.status = 'active')))
                            and p.paid_on >= w.period_start
                            and p.paid_on < (w.period_start + case w.period when 'month' then interval '1 month'
                                                                            when 'quarter' then interval '3 months'
                                                                            else interval '1 year' end)::date
                            -- (17) (ג): a cheque once cleared or due (keep in step with app.goal_payments_counted)
                            and (p.cheque_status is null or p.cheque_status = 'cleared'
                                 or (p.cheque_status <> 'bounced' and p.cheque_due_date <= org.today))
      left join public.deals dl on dl.organization_id = p.organization_id and dl.id = p.deal_id
      left join public.contacts ct on ct.organization_id = p.organization_id and ct.id = p.contact_id
     where exists (select 1 from g where g.metric = 'collected')
    union all
    select w.period, w.period_start, coalesce(dl.owner_id, ct.owner_id), coalesce(dl.team_id, ct.team_id),
           -r.amount_agorot::numeric
      from windows w
      cross join org
      join public.payment_refunds r on r.organization_id = p_org and r.status = 'active'
                                   and r.refunded_on >= w.period_start
                                   and r.refunded_on < (w.period_start + case w.period when 'month' then interval '1 month'
                                                                                       when 'quarter' then interval '3 months'
                                                                                       else interval '1 year' end)::date
      join public.payments p on p.organization_id = r.organization_id and p.id = r.payment_id
                            and p.status in ('recorded', 'confirmed', 'refunded')
                            -- (17) (ג): the payment's cheque rule (keep in step with app.goal_payments_counted)
                            and (p.cheque_status is null or p.cheque_status = 'cleared'
                                 or (p.cheque_status <> 'bounced' and p.cheque_due_date <= org.today))
      left join public.deals dl on dl.organization_id = p.organization_id and dl.id = p.deal_id
      left join public.contacts ct on ct.organization_id = p.organization_id and ct.id = p.contact_id
     where exists (select 1 from g where g.metric = 'collected')
  ), pay_facts as (
    select pr.period, pr.period_start, pr.user_id, pr.team_id, sum(pr.value)::numeric as value, count(*)::bigint as n
      from pay_rows pr
     group by 1, 2, 3, 4
  ), facts as (
    -- what each person did, and on records of which team
    select w.period, w.period_start, 'won_amount'::text as metric, d.owner_id as user_id, d.team_id,
           sum(d.amount_agorot)::numeric as value
      from windows w
      join public.deals d on d.organization_id = p_org and d.deleted_at is null and d.status = 'won'
                         and d.closed_at >= w.t_from and d.closed_at < w.t_to
     where exists (select 1 from g where g.metric = 'won_amount')
     group by 1, 2, 4, 5
    union all
    select w.period, w.period_start, 'won_deals', d.owner_id, d.team_id, count(*)::numeric
      from windows w
      join public.deals d on d.organization_id = p_org and d.deleted_at is null and d.status = 'won'
                         and d.closed_at >= w.t_from and d.closed_at < w.t_to
     where exists (select 1 from g where g.metric = 'won_deals')
     group by 1, 2, 4, 5
    union all
    select w.period, w.period_start, 'leads_handled', l.owner_id, l.team_id, count(*)::numeric
      from windows w
      join first_contact f on f.at >= w.t_from and f.at < w.t_to
      join public.leads l on l.organization_id = p_org and l.id = f.lead_id and l.deleted_at is null
     group by 1, 2, 4, 5
    union all
    select w.period, w.period_start, 'meetings_held', a.created_by,
           app.activity_goal_team(p_org, a.deal_id, a.lead_id, a.contact_id, a.company_id), count(*)::numeric
      from windows w
      join public.activities a on a.organization_id = p_org and a.type = 'meeting' and a.created_by is not null
                              and a.occurred_at >= w.t_from and a.occurred_at < w.t_to
                              and a.occurred_at <= now() + interval '5 minutes'
     where exists (select 1 from g where g.metric = 'meetings_held')
     group by 1, 2, 4, 5
    union all
    select pf.period, pf.period_start, 'collected', pf.user_id, pf.team_id, pf.value from pay_facts pf
  ), tree as (
    -- each team goal's team and the teams below it
    with recursive t (root, team_id, depth) as (
      select tm.id, tm.id, 1
        from public.teams tm
       where tm.organization_id = p_org and tm.id in (select g.team_id from g where g.scope = 'team')
      union all
      select t.root, c.id, t.depth + 1
        from t join public.teams c on c.organization_id = p_org and c.parent_team_id = t.team_id
       where t.depth < 10
    )
    select distinct t.root, t.team_id from t
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'goal_id', r.id,
           'scope', r.scope,
           'user_id', r.user_id,
           'team_id', r.team_id,
           'period', r.period,
           'period_start', r.period_start,
           'metric', r.metric,
           'target', r.target,
           'actual', r.actual,
           'elapsed', r.elapsed)
         order by array_position(array['org', 'team', 'user'], r.scope),
                  array_position(array['won_amount', 'won_deals', 'leads_handled', 'meetings_held', 'collected'], r.metric),
                  array_position(array['month', 'quarter', 'year'], r.period),
                  r.period_start, r.id), '[]'::jsonb)
    from (
      select g.id, g.scope, g.user_id, g.team_id, g.period, g.period_start, g.metric, g.target,
             coalesce((
               select sum(f.value) from facts f
                where f.period = g.period and f.period_start = g.period_start and f.metric = g.metric
                  and (g.scope = 'org'
                       or (g.scope = 'user' and f.user_id = g.user_id)
                       or (g.scope = 'team' and f.team_id in (select tree.team_id from tree where tree.root = g.team_id)))
             ), 0)::bigint as actual,
             round(greatest(0, least(1,
               extract(epoch from (now() - g.t_from)) / nullif(extract(epoch from (g.t_to - g.t_from)), 0)))::numeric, 4) as elapsed
        from g
       where case when g.metric = 'collected' then
               -- GOL-01 collection: every payment that counts for the goal is one the caller reads
               coalesce((
                 select sum(pf.n) from pay_facts pf
                  where pf.period = g.period and pf.period_start = g.period_start
                    and (g.scope = 'org'
                         or (g.scope = 'user' and pf.user_id = g.user_id)
                         or (g.scope = 'team' and pf.team_id in (select tree.team_id from tree where tree.root = g.team_id)))
               ), 0) = app.goal_payments_counted(p_org, g.id)
             else
             app.is_admin(p_org)
          -- platform support in an open session, unless they are also a member (then their role decides)
          or (app.membership_role(p_org) is null and app.support_session(p_org))
          or (select visibility from org) = 'org'
          -- a team's goal: its manager reads every record of the team and the teams below it
          -- (and of every team the goal counts: a tree deeper than app.manages_team reaches is not whole)
          or (g.scope = 'team' and app.goals_manages_team(p_org, g.team_id)
              and not exists (select 1 from tree where tree.root = g.team_id and not app.manages_team(tree.team_id)))
          or (g.scope = 'team' and (select visibility from org) = 'team'
              and not exists (select 1 from tree where tree.root = g.team_id and not app.in_team(tree.team_id)))
          -- a person's own goal; for meetings only while every entry they wrote in the period is on
          -- a record they may still read (activities_select would hide the others)
          or (g.scope = 'user' and g.user_id = (select auth.uid())
              and (g.metric <> 'meetings_held' or app.goal_entries_readable(p_org, g.user_id, g.t_from, g.t_to)))
             end
    ) r;
$function$;

