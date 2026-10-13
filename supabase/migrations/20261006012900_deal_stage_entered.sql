-- Stuck deals by time in stage (owner's decision, 13 October 2026: DEAL-01, MNY-01, MNY-05).
--
-- A deal is stuck when the whole days since it entered its current stage are more than the
-- stage's rot_days (null = 14, additions spec 22.9). This is the one definition: the board
-- badge, the deal page, the stuck-deals report and, later, MNY-01 and MNY-05 read it from
-- public.report_stuck_deals(). Days without activity no longer make a deal stuck; the
-- report still returns them (idle_days, last_activity_at) so screens can say "last activity
-- X days ago", and lists put the deals without activity first.
-- A deal postponed with a date (deals.snoozed_until) is not stuck before that day, in the
-- organization's time zone. Won and lost deals are never stuck (only open deals are read).
--
-- deals.stage_entered_at has existed since 0002 (not null, default now()), and
-- app.sync_deal_stage() (deals_sync_stage, security definer, every writer) sets it on insert
-- and whenever the stage or pipeline changes. Two things are added here:
--   * deals has a table-wide UPDATE grant, so a person could write stage_entered_at on an
--     update that keeps the stage. Trigger deals_sync_stage_entered keeps the old value on
--     such a browser write. Server writers are not limited.
--   * deals.snoozed_until date, written by whoever may edit the deal; a move to another stage
--     cancels it and logs one timeline line (owner, 13 October 2026).
-- The stage-entry fill the owner asked for (last stage change from the audit log, else the
-- last update) applies only to deals without a stage-entry date; the column is not null, so
-- there are none. The block at the end counts them and reports the number.
-- Every statement is safe to run twice.

alter table public.deals add column if not exists snoozed_until date;

-- deals has a table-wide grant today; this keeps the column writable if it ever moves to
-- column grants (as leads, contacts and tasks did)
grant insert (snoozed_until), update (snoozed_until) on public.deals to authenticated;

-- Trigger deals_sync_stage_entered (before insert or update; after deals_sync_stage and
-- deals_sync_stage_close by name, before deals_sync_stage_loss):
--   * a browser update that keeps the stage keeps stage_entered_at (a person cannot write it);
--   * a move to another stage or pipeline (also reopening a closed deal) cancels the
--     postponement, for every writer (owner, 13 October 2026); the timeline line is written by
--     deals_snooze_cleared below;
--   * a person may postpone only to a day after today and at most 366 days ahead, in the
--     organization's time zone (hint deal:snoozed_until). Server writers are not limited.
create or replace function app.deal_stage_entered() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_today date;
begin
  -- security invoker on purpose: current_user tells a browser write from a server one.
  -- app.sync_deal_stage() already stamped now() on an insert and on a change of stage.
  if tg_op = 'UPDATE' and (new.stage_id <> old.stage_id or new.pipeline_id <> old.pipeline_id) then
    new.snoozed_until := null;
  elsif tg_op = 'UPDATE' and current_user = 'authenticated' then
    new.stage_entered_at := old.stage_entered_at;
  end if;

  if current_user = 'authenticated' and new.snoozed_until is not null
     and (tg_op = 'INSERT' or new.snoozed_until is distinct from old.snoozed_until) then
    v_today := (now() at time zone coalesce(
                 (select o.timezone from public.organizations o where o.id = new.organization_id), 'Asia/Jerusalem'))::date;
    -- only an open deal can be postponed (new.status is the stage's kind: deals_sync_stage ran first)
    if new.status is distinct from 'open' or new.snoozed_until <= v_today or new.snoozed_until > v_today + 366 then
      raise exception 'snooze date out of range' using errcode = 'P0001', hint = 'deal:snoozed_until';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.deal_stage_entered() from public, anon, authenticated;

create or replace trigger deals_sync_stage_entered before insert or update on public.deals
  for each row execute function app.deal_stage_entered();

-- The timeline line of a cancelled postponement: only when the deal was still postponed
-- (its day after today). A server entry of type system (app.touch_row puts the mover in
-- created_by when a person moved the deal, as on the stage_change entry). It is not contact
-- (app.stamp_last_contact and the activation take contact types only); report_stuck_deals
-- leaves it out of "last activity" (metadata kind snooze_cleared); it notifies nobody
-- (followers and mentions react to a browser insert only, and this function is security
-- definer); and its time is the time of the stage_change entry of the same move, so "no
-- activity" automations see no new time.
create or replace function app.log_deal_snooze_cleared() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_today date;
  v_stage text;
begin
  if old.snoozed_until is null or new.snoozed_until is not null
     or (new.stage_id = old.stage_id and new.pipeline_id = old.pipeline_id) then
    return null;
  end if;
  v_today := (now() at time zone coalesce(
               (select o.timezone from public.organizations o where o.id = new.organization_id), 'Asia/Jerusalem'))::date;
  if old.snoozed_until <= v_today then
    return null;
  end if;
  select s.name into v_stage from public.stages s where s.organization_id = new.organization_id and s.id = new.stage_id;
  insert into public.activities (organization_id, type, deal_id, body, metadata, created_by)
  values (new.organization_id, 'system', new.id,
          'הדחייה בוטלה כי העסקה עברה לשלב ' || coalesce(v_stage, 'אחר'),
          jsonb_build_object('kind', 'snooze_cleared', 'snoozed_until', old.snoozed_until, 'stage_id', new.stage_id),
          auth.uid());
  return null;
end;
$$;
revoke all on function app.log_deal_snooze_cleared() from public, anon, authenticated;

create or replace trigger deals_snooze_cleared after update of stage_id, pipeline_id on public.deals
  for each row execute function app.log_deal_snooze_cleared();

-- The stuck-deals report (latest body: 0069), now stuck by time in stage.
--   stuck         days_in_stage > limit_days, and not postponed past today
--   postponed     would be stuck, but postponed to a day after today (managers see it)
--   no_next_step  no open task and no planned meeting that has not ended (unchanged; a
--                 different concept, "My day" and the board read it)
-- A row is returned when any holds. Order: stuck deals first, so the limit never cuts one
-- for a deal that is only without a next step; within each group deals without activity first
-- (no activity at all, then the oldest last activity), then the longest in stage, then the largest.
-- security invoker on purpose (RLS decides what is counted), like every report.
create or replace function public.report_stuck_deals(
  p_org uuid, p_pipeline uuid default null, p_owner uuid default null, p_days integer default 14)
returns jsonb
language sql stable
set search_path = ''
as $$
  with today as (
    select (now() at time zone coalesce(
             (select o.timezone from public.organizations o where o.id = p_org), 'Asia/Jerusalem'))::date as d
  )
  select coalesce(jsonb_agg(r order by r.stuck desc, r.last_activity_at asc nulls first, r.days_in_stage desc, r.amount_agorot desc, r.id),
                  '[]'::jsonb)
    from (
      select y.*
        from (
          select x.*,
                 (x.days_in_stage > x.limit_days
                  and (x.snoozed_until is null or x.snoozed_until <= (select d from today))) as stuck,
                 (x.days_in_stage > x.limit_days
                  and x.snoozed_until is not null and x.snoozed_until > (select d from today)) as postponed,
                 (x.next_task_at is null and x.next_meeting_at is null) as no_next_step
            from (
              select d.id, d.name, d.amount_agorot, d.owner_id, d.pipeline_id, s.name as stage_name,
                     coalesce(s.rot_days, greatest(coalesce(p_days, 14), 1)) as limit_days,
                     d.stage_entered_at,
                     greatest(floor(extract(epoch from now() - d.stage_entered_at) / 86400), 0)::int as days_in_stage,
                     d.snoozed_until,
                     la.last_at as last_activity_at,
                     greatest(floor(extract(epoch from now() - coalesce(la.last_at, d.created_at)) / 86400), 0)::int as idle_days,
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
            ) x
        ) y
       where y.stuck or y.no_next_step or y.postponed
       order by y.stuck desc, y.last_activity_at asc nulls first, y.days_in_stage desc, y.amount_agorot desc, y.id
       limit 200
    ) r;
$$;
revoke all on function public.report_stuck_deals(uuid, uuid, uuid, integer) from public, anon;
grant execute on function public.report_stuck_deals(uuid, uuid, uuid, integer) to authenticated;

-- The stage-entry fill: deals without a stage-entry date (none can exist while the column is
-- not null). Reports how many there are; nothing is rewritten.
do $$
declare
  v_missing bigint;
begin
  select count(*) into v_missing from public.deals where stage_entered_at is null;
  raise notice 'deal_stage_entered: % deals without a stage-entry date, 0 filled', v_missing;
end;
$$;
