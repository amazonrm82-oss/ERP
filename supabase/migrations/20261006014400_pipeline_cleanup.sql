-- =============================================================================
-- Weekly pipeline cleanup (MNY-05)
-- =============================================================================
-- public.report_pipeline_cleanup(org, owner): the open deals that need a decision
-- (advance, postpone with a date, or close as lost with a reason), each once:
--
-- * stuck (owner, 13 October 2026; the one definition, as in report_stuck_deals
--   since 0129): whole days since the deal entered its stage > the stage's
--   rot_days (null = 14), and not postponed past today. Kept identical to
--   report_stuck_deals: tests/db/93-pipeline-cleanup.test.ts compares the two.
-- * overdue (owner, 13 October 2026, GOL-04 answer 4): expected_close_date before
--   today, also when not stuck by time in stage. A deal postponed past today is
--   left out here too, so "postpone with a date" takes it off the list until then.
-- * today is the organization's date (time zone, default Asia/Jerusalem).
-- * Each row says why (stuck, overdue, or both), the days in stage and the limit,
--   and when the last activity was (as report_stuck_deals: a person's entry,
--   not the "postponement cancelled" line). Order (owner, 13 October 2026): deals
--   without activity first, then the oldest last activity, then the longest in
--   stage, then the largest. At most 300 rows; the totals count every deal.
-- * The totals split the deals once each: stuck, and overdue that is not stuck
--   (MNY-01 reads them; it counts every deal once).
-- * SECURITY INVOKER, like every report: RLS decides which deals the caller sees.
-- Every statement is safe to run twice. Nothing is removed.

create or replace function public.report_pipeline_cleanup(p_org uuid, p_owner uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  with cur as (
    select (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date as today
      from public.organizations o
     where o.id = p_org
  ), x as (
    select d.id, d.name, d.owner_id, d.pipeline_id, d.stage_id, s.name as stage_name, s.position as stage_position,
           d.amount_agorot, d.contact_id, d.expected_close_date, d.snoozed_until,
           coalesce(s.rot_days, 14) as limit_days,
           greatest(floor(extract(epoch from now() - d.stage_entered_at) / 86400), 0)::int as days_in_stage,
           la.last_at as last_activity_at,
           greatest(floor(extract(epoch from now() - coalesce(la.last_at, d.created_at)) / 86400), 0)::int as idle_days
      from public.deals d
      join public.stages s on s.organization_id = d.organization_id and s.id = d.stage_id
      left join lateral (
        select max(a.occurred_at) as last_at from public.activities a
         where a.organization_id = d.organization_id and a.deal_id = d.id and a.created_by is not null
           and not (a.type = 'system' and a.metadata ->> 'kind' = 'snooze_cleared')
      ) la on true
     where d.organization_id = p_org and d.deleted_at is null and d.status = 'open'
       and (p_owner is null or d.owner_id = p_owner)
       and exists (select 1 from cur)
  ), y as (
    select x.*,
           (x.snoozed_until is null or x.snoozed_until <= (select today from cur)) as awake,
           (x.days_in_stage > x.limit_days) as over_limit,
           (x.expected_close_date is not null and x.expected_close_date < (select today from cur)) as past_close
      from x
  ), r as (
    select y.id, y.name, y.owner_id, y.pipeline_id, y.stage_id, y.stage_name, y.stage_position, y.amount_agorot,
           y.contact_id, y.expected_close_date, y.days_in_stage, y.limit_days, y.last_activity_at, y.idle_days,
           (y.over_limit and y.awake) as stuck,
           (y.past_close and y.awake) as overdue
      from y
     where y.awake and (y.over_limit or y.past_close)
  )
  select jsonb_build_object(
    'today', (select today from cur),
    'stuck', (select jsonb_build_object('deals', count(*), 'amount', coalesce(sum(r.amount_agorot), 0)) from r where r.stuck),
    'overdue', (select jsonb_build_object('deals', count(*), 'amount', coalesce(sum(r.amount_agorot), 0)) from r where r.overdue and not r.stuck),
    'deals', coalesce((
      select jsonb_agg(z order by z.last_activity_at asc nulls first, z.days_in_stage desc, z.amount_agorot desc, z.id)
        from (
          select r.* from r
           order by r.last_activity_at asc nulls first, r.days_in_stage desc, r.amount_agorot desc, r.id
           limit 300
        ) z), '[]'::jsonb))
  where exists (select 1 from cur);
$$;

revoke all on function public.report_pipeline_cleanup(uuid, uuid) from public, anon;
grant execute on function public.report_pipeline_cleanup(uuid, uuid) to authenticated;
