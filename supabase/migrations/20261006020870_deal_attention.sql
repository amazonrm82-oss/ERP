-- DEAL-02 gap: the stuck / postponed / no-next-step marks of the deals board and the deal page.
--
-- Until now the board read public.report_stuck_deals(), which answers at most 200 rows (the report
-- screen's cap), so on a large board some stuck deals were not marked. The rule now lives in ONE
-- place, app.deal_attention_rows() (security invoker, so RLS decides which deals are seen; plain
-- SQL without a SET clause and with schema-qualified names, so the planner can inline it):
--   * public.report_stuck_deals() is the same rows filtered to the ones that need attention, ordered
--     and capped at 200 as before (same result, same signature, same grants);
--   * public.deal_attention(org, deal ids) (new, security invoker) answers the same row for every
--     listed deal that needs attention, with no cap: the board passes the deals it shows, the deal
--     page passes its deal.
-- "My day" (TASK-09) keeps reading report_stuck_deals. report_pipeline_cleanup keeps its own copy
-- of the stuck rule (test 93 compares the two).
--
-- Safe to run twice: create or replace only.

create or replace function app.deal_attention_rows(
  p_org uuid, p_pipeline uuid, p_owner uuid, p_days integer, p_ids uuid[])
returns table (
  id uuid, name text, amount_agorot bigint, owner_id uuid, pipeline_id uuid, stage_name text,
  limit_days integer, stage_entered_at timestamptz, days_in_stage integer, snoozed_until date,
  last_activity_at timestamptz, idle_days integer, next_task_at timestamptz, next_meeting_at timestamptz,
  stuck boolean, postponed boolean, no_next_step boolean)
language sql stable
as $$
  with today as (
    select (now() at time zone coalesce(
             (select o.timezone from public.organizations o where o.id = p_org), 'Asia/Jerusalem'))::date as d
  )
  select x.id, x.name, x.amount_agorot, x.owner_id, x.pipeline_id, x.stage_name,
         x.limit_days, x.stage_entered_at, x.days_in_stage, x.snoozed_until,
         x.last_activity_at, x.idle_days, x.next_task_at, x.next_meeting_at,
         (x.days_in_stage > x.limit_days
          and (x.snoozed_until is null or x.snoozed_until <= (select d from today))) as stuck,
         (x.days_in_stage > x.limit_days
          and x.snoozed_until is not null and x.snoozed_until > (select d from today)) as postponed,
         (x.next_task_at is null and x.next_meeting_at is null) as no_next_step
    from (
      select d.id, d.name, d.amount_agorot::bigint as amount_agorot, d.owner_id, d.pipeline_id, s.name as stage_name,
             coalesce(s.rot_days, greatest(coalesce(p_days, 14), 1))::integer as limit_days,
             d.stage_entered_at,
             greatest(floor(extract(epoch from now() - d.stage_entered_at) / 86400), 0)::integer as days_in_stage,
             d.snoozed_until,
             la.last_at as last_activity_at,
             greatest(floor(extract(epoch from now() - coalesce(la.last_at, d.created_at)) / 86400), 0)::integer as idle_days,
             (select min(coalesce(t.due_at, t.created_at)) from public.tasks t
               where t.organization_id = d.organization_id and t.deal_id = d.id
                 and t.status = 'open' and t.deleted_at is null) as next_task_at,
             (select min(m.starts_at) from public.meetings m
               where m.organization_id = d.organization_id and m.deal_id = d.id
                 and m.status = 'planned' and m.ends_at > now()) as next_meeting_at
        from public.deals d
        join public.stages s on s.organization_id = d.organization_id and s.id = d.stage_id
        left join lateral (
          select max(a.occurred_at) as last_at from public.activities a
           where a.organization_id = d.organization_id and a.deal_id = d.id and a.created_by is not null
             and not (a.type = 'system' and a.metadata ->> 'kind' = 'snooze_cleared')
        ) la on true
       where d.organization_id = p_org and d.deleted_at is null and d.status = 'open'
         and (p_pipeline is null or d.pipeline_id = p_pipeline)
         and (p_owner is null or d.owner_id = p_owner)
         and (p_ids is null or d.id = any (p_ids))
    ) x
$$;
revoke all on function app.deal_attention_rows(uuid, uuid, uuid, integer, uuid[]) from public, anon;
grant execute on function app.deal_attention_rows(uuid, uuid, uuid, integer, uuid[]) to authenticated;

-- The report: unchanged result (same keys, order and cap of 200), read from the shared rule.
create or replace function public.report_stuck_deals(
  p_org uuid, p_pipeline uuid default null, p_owner uuid default null, p_days integer default 14)
returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(r order by r.stuck desc, r.last_activity_at asc nulls first, r.days_in_stage desc, r.amount_agorot desc, r.id),
                  '[]'::jsonb)
    from (
      select y.*
        from app.deal_attention_rows(p_org, p_pipeline, p_owner, p_days, null) y
       where y.stuck or y.no_next_step or y.postponed
       order by y.stuck desc, y.last_activity_at asc nulls first, y.days_in_stage desc, y.amount_agorot desc, y.id
       limit 200
    ) r;
$$;
revoke all on function public.report_stuck_deals(uuid, uuid, uuid, integer) from public, anon;
grant execute on function public.report_stuck_deals(uuid, uuid, uuid, integer) to authenticated;

-- The board and the deal page: the same row for each listed deal that needs attention (open, seen
-- by the caller, stuck, postponed or without a next step), no cap. Deals not listed, closed, in the
-- recycle bin, of another organization or hidden by RLS are simply absent.
create or replace function public.deal_attention(p_org uuid, p_deals uuid[])
returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(r order by r.stuck desc, r.last_activity_at asc nulls first, r.days_in_stage desc, r.amount_agorot desc, r.id),
                  '[]'::jsonb)
    from (
      select y.*
        from app.deal_attention_rows(p_org, null, null, 14, coalesce(p_deals, '{}'::uuid[])) y
       where y.stuck or y.no_next_step or y.postponed
    ) r;
$$;
revoke all on function public.deal_attention(uuid, uuid[]) from public, anon;
grant execute on function public.deal_attention(uuid, uuid[]) to authenticated;
