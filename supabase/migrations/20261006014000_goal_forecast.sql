-- =============================================================================
-- Forecast against the goal (GOL-04)
-- =============================================================================
-- public.report_goal_forecast(org, pipeline, owner): the forecast screen. Open
-- deals weighted as in report_forecast (amount_agorot * probability / 100; a
-- deal's probability follows its stage), by expected close month, against the
-- won_amount goal of that month.
--
-- * today: the organization's date (time zone, default Asia/Jerusalem).
-- * overdue: open deals whose expected_close_date is before today. They are a
--   line of their own, never inside a month (owner, 13 October 2026), and listed
--   in overdue_deals (the 200 oldest dates first, with their pipeline; overdue.deals
--   has the full count) so the screen can mark them "תאריך הסגירה עבר" and offer a
--   new date, a win or a loss.
-- * undated: open deals with no expected close date, a line of their own.
-- * months: the current month always; every later month with a dated open deal;
--   and every month of the next twelve that has a goal. Each month: deals, amount,
--   weighted, won_amount (closed won in that month, report_revenue's definition)
--   and goal: the target of the month's won_amount goal. With p_owner it is that
--   person's goal (scope user), otherwise the business's (scope org); goal_scope
--   says which. null when there is none, or the caller may not read it.
-- * by_owner / by_stage: the same open deals by owner and by stage (with the
--   pipeline's name, since without p_pipeline every pipeline is counted), each
--   with the weighted value of the deals expected this month (month_weighted)
--   and the overdue part (overdue_deals, overdue_weighted).
-- * complete (owner, 13 October 2026, as in report_goal_progress): the caller
--   sees every deal the goal is about: owners, admins, an open support session,
--   'org' visibility, or p_owner = the caller (their own deals and own goal).
--   When it is false, or a pipeline is picked (a goal covers every pipeline),
--   goal is null: the forecast shows without a comparison.
-- * Weighted values are summed unrounded and rounded once per total, like
--   report_forecast.
-- * report_forecast is unchanged (FXC-12 callers and samples keep working).
-- * SECURITY INVOKER, like every report: RLS decides which deals and goals count.
-- Every statement is safe to run twice. No deletes, no drops.

create or replace function public.report_goal_forecast(
  p_org uuid, p_pipeline uuid default null, p_owner uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  with org as (
    select coalesce(o.timezone, 'Asia/Jerusalem') as tz,
           (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date as today,
           (app.is_admin(p_org) or (app.membership_role(p_org) is null and app.support_session(p_org))
            or o.record_visibility = 'org'
            or (p_owner is not null and p_owner = (select auth.uid()))) as complete
      from public.organizations o
     where o.id = p_org
  ), cur as (
    select org.tz, org.today, org.complete, date_trunc('month', org.today)::date as month from org
  ), d as (
    select d.id, d.name, d.owner_id, d.stage_id, d.pipeline_id, d.expected_close_date,
           d.amount_agorot as amount,
           d.amount_agorot * d.probability / 100.0 as weighted,
           case when d.expected_close_date is null then 'undated'
                when d.expected_close_date < (select today from cur) then 'overdue'
                else 'month' end as bucket,
           date_trunc('month', d.expected_close_date)::date as month
      from public.deals d
     where d.organization_id = p_org and d.deleted_at is null and d.status = 'open'
       and (p_pipeline is null or d.pipeline_id = p_pipeline)
       and (p_owner is null or d.owner_id = p_owner)
       and exists (select 1 from cur)
  ), goal as (
    select g.period_start as month, g.target
      from public.goals g
     where g.organization_id = p_org and g.period = 'month' and g.metric = 'won_amount'
       and p_pipeline is null and (select complete from cur)
       and case when p_owner is null then g.scope = 'org' else g.scope = 'user' and g.user_id = p_owner end
       and g.period_start >= (select month from cur)
       and g.period_start < (select month from cur) + interval '12 months'
  ), months as (
    select month from cur
    union
    select month from d where bucket = 'month'
    union
    select month from goal
  ), won as (
    select date_trunc('month', w.closed_at at time zone (select tz from cur))::date as month,
           sum(w.amount_agorot) as amount
      from public.deals w
     where w.organization_id = p_org and w.deleted_at is null and w.status = 'won'
       and w.closed_at >= ((select month from cur)::timestamp at time zone (select tz from cur))
       and (p_pipeline is null or w.pipeline_id = p_pipeline)
       and (p_owner is null or w.owner_id = p_owner)
     group by 1
  ), totals as (
    select bucket, count(*) as deals, coalesce(sum(amount), 0) as amount, coalesce(round(sum(weighted)), 0)::bigint as weighted
      from d group by bucket
  )
  select jsonb_build_object(
    'today', (select today from cur),
    'goal_scope', case when p_owner is null then 'org' else 'user' end,
    'complete', (select complete from cur),
    'months', coalesce((
      select jsonb_agg(jsonb_build_object(
               'month', m.month,
               'deals', (select count(*) from d where d.bucket = 'month' and d.month = m.month),
               'amount', (select coalesce(sum(d.amount), 0) from d where d.bucket = 'month' and d.month = m.month),
               'weighted', (select coalesce(round(sum(d.weighted)), 0)::bigint from d where d.bucket = 'month' and d.month = m.month),
               'won_amount', coalesce((select won.amount from won where won.month = m.month), 0),
               'goal', (select goal.target from goal where goal.month = m.month))
             order by m.month)
        from months m), '[]'::jsonb),
    'overdue', (select jsonb_build_object('deals', coalesce(max(deals), 0), 'amount', coalesce(max(amount), 0), 'weighted', coalesce(max(weighted), 0))
                  from totals where bucket = 'overdue'),
    'undated', (select jsonb_build_object('deals', coalesce(max(deals), 0), 'amount', coalesce(max(amount), 0), 'weighted', coalesce(max(weighted), 0))
                  from totals where bucket = 'undated'),
    'by_owner', coalesce((
      select jsonb_agg(r order by r.weighted desc, r.deals desc)
        from (
          select d.owner_id, count(*) as deals, coalesce(sum(d.amount), 0) as amount, coalesce(round(sum(d.weighted)), 0)::bigint as weighted,
                 coalesce(round(sum(d.weighted) filter (where d.bucket = 'month' and d.month = (select month from cur))), 0)::bigint as month_weighted,
                 count(*) filter (where d.bucket = 'overdue') as overdue_deals,
                 coalesce(round(sum(d.weighted) filter (where d.bucket = 'overdue')), 0)::bigint as overdue_weighted
            from d group by d.owner_id
        ) r), '[]'::jsonb),
    'by_stage', coalesce((
      select jsonb_agg(r order by r.pipeline_name, r.pipeline_id, r.position, r.stage_id)
        from (
          select d.stage_id, s.name, s.position, d.pipeline_id, p.name as pipeline_name,
                 count(*) as deals, coalesce(sum(d.amount), 0) as amount, coalesce(round(sum(d.weighted)), 0)::bigint as weighted,
                 coalesce(round(sum(d.weighted) filter (where d.bucket = 'month' and d.month = (select month from cur))), 0)::bigint as month_weighted,
                 count(*) filter (where d.bucket = 'overdue') as overdue_deals,
                 coalesce(round(sum(d.weighted) filter (where d.bucket = 'overdue')), 0)::bigint as overdue_weighted
            from d
            left join public.stages s on s.organization_id = p_org and s.id = d.stage_id
            left join public.pipelines p on p.organization_id = p_org and p.id = d.pipeline_id
           group by d.stage_id, s.name, s.position, d.pipeline_id, p.name
        ) r), '[]'::jsonb),
    'overdue_deals', coalesce((
      select jsonb_agg(r order by r.expected_close_date, r.id)
        from (
          select d.id, d.name, d.owner_id, d.pipeline_id, s.name as stage_name, d.amount as amount_agorot,
                 round(d.weighted)::bigint as weighted, d.expected_close_date
            from d
            left join public.stages s on s.organization_id = p_org and s.id = d.stage_id
           where d.bucket = 'overdue'
           order by d.expected_close_date, d.id
           limit 200
        ) r), '[]'::jsonb))
  where exists (select 1 from cur);
$$;

revoke all on function public.report_goal_forecast(uuid, uuid, uuid) from public, anon;
grant execute on function public.report_goal_forecast(uuid, uuid, uuid) to authenticated;
