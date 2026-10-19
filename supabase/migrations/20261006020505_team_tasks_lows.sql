-- =============================================================================
-- TASK-07 follow-ups (review lows): viewers, automations and recurring spawns
-- =============================================================================
-- * A viewer in the team no longer sees an open team task through the team rule (they can neither make nor take one;
--   app.can_read_record still decides what a viewer reads otherwise).
-- * The one-time team notice goes out only for a team task a person makes by hand: not for one an automation makes
--   while a person runs it (run_automation_now sets app.automation_running), and not for the next occurrence of a
--   recurring task (recurrence_source_id is set by app.spawn_recurring_task).
-- Redefines app.team_task_visible and app.notify_team_task of 020490 with the same signatures. Safe to run twice.

create or replace function app.team_task_visible(p_org uuid, p_id uuid, p_owner uuid, p_team uuid, p_status public.task_status, p_deleted timestamptz)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_owner is null and p_team is not null and p_status = 'open' and p_deleted is null
     and app.membership_role(p_org) in ('owner', 'admin', 'manager', 'member')
     and exists (select 1 from public.team_members tm
                  where tm.organization_id = p_org and tm.team_id = p_team and tm.user_id = auth.uid())
     and not exists (select 1 from app.intake_callback_tasks ct where ct.organization_id = p_org and ct.task_id = p_id)
$$;
revoke all on function app.team_task_visible(uuid, uuid, uuid, uuid, public.task_status, timestamptz) from public, anon;
grant execute on function app.team_task_visible(uuid, uuid, uuid, uuid, public.task_status, timestamptz) to authenticated, service_role;

-- a person's new team task: one notice to each active full-seat member of the team, not its creator
create or replace function app.notify_team_task() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.owner_id is not null or new.team_id is null or new.status <> 'open' or new.deleted_at is not null or auth.uid() is null
     or coalesce(current_setting('app.automation_running', true), '') = 'on'
     or new.recurrence_source_id is not null then
    return null;
  end if;
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select new.organization_id, m.user_id, 'assigned', left('משימת צוות: ' || new.title, 200), 'מי שלוקח ראשון הופך לאחראי', 'task', new.id
    from public.team_members tm
    join public.memberships m on m.organization_id = tm.organization_id and m.user_id = tm.user_id
   where tm.organization_id = new.organization_id and tm.team_id = new.team_id
     and m.status = 'active' and m.seat_type = 'full' and m.role in ('owner', 'admin', 'manager', 'member')
     and m.user_id <> auth.uid();
  return null;
end;
$$;
revoke all on function app.notify_team_task() from public, anon, authenticated;
