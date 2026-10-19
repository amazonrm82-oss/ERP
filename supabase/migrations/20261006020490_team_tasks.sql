-- =============================================================================
-- TASK-07: a task for a team, first one to take it becomes its owner
-- =============================================================================
-- Owner, 18 October 2026: (1) every member of the team sees the task until someone takes it; (2) every full-seat member
-- of the team gets one notice, of the normal task kind ('assigned'); after it is taken, notices go to the taker only.
-- * A team task is an open task with a team and no owner, other than a lead's call-back task (SPD-01), which follows
--   its lead and is taken by taking the lead.
-- * Visibility: tasks_select adds such a task for an active member of its team (app.team_task_visible). Owners, admins and
--   the team's managers already read it (app.can_read_record). Nothing else about tasks' rights changes: a team member
--   does not edit a team task before taking it.
-- * Making one: a person who sends a team and no owner keeps it unowned (until now the insert made them the owner) when
--   they may give tasks to that team: an owner or admin, a manager of the team, or a member of it who is not a viewer
--   (app.may_assign_team_task; otherwise 42501, hint task:team). Without a team the creator is the owner, as before.
-- * public.take_task(org, task) (definer): an active owner/admin/manager/member of a writable business who is in the
--   team, manages it, or is an owner/admin. First one wins (owner_id is null in the update); the task keeps its team.
--   Answers {ok, owner_id} or {ok:false, reason: taken|closed|lead}: a lead's call-back task is taken through its lead
--   (SPD-01's "לקחתי"), so the task keeps following the lead's owner.
-- * Notices: a person's new team task tells the team's active full-seat members (not its creator) once, kind 'assigned'
--   (trigger tasks_notify_team). Taking it tells nobody else; reminders go to the owner only, as before
--   (app.send_task_reminders reminds owned tasks; an unowned team task is not reminded until it is taken).
-- Additive only. Safe to run twice.

create or replace function app.may_assign_team_task(p_org uuid, p_team uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_team is not null and coalesce(
    app.membership_role(p_org) in ('owner', 'admin')
    or (app.membership_role(p_org) = 'manager' and app.manages_team(p_team))
    or (app.membership_role(p_org) in ('manager', 'member')
        and exists (select 1 from public.team_members tm
                     where tm.organization_id = p_org and tm.team_id = p_team and tm.user_id = auth.uid())),
    false)
$$;
revoke all on function app.may_assign_team_task(uuid, uuid) from public, anon;
grant execute on function app.may_assign_team_task(uuid, uuid) to authenticated, service_role;

-- an open team task with no owner, for an active member of that team. A lead's call-back task (SPD-01) is not a team
-- task: it follows its lead, and its title names the person, so it stays with whoever reads the lead.
create or replace function app.team_task_visible(p_org uuid, p_id uuid, p_owner uuid, p_team uuid, p_status public.task_status, p_deleted timestamptz)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_owner is null and p_team is not null and p_status = 'open' and p_deleted is null
     and app.membership_role(p_org) is not null
     and exists (select 1 from public.team_members tm
                  where tm.organization_id = p_org and tm.team_id = p_team and tm.user_id = auth.uid())
     and not exists (select 1 from app.intake_callback_tasks ct where ct.organization_id = p_org and ct.task_id = p_id)
$$;
revoke all on function app.team_task_visible(uuid, uuid, uuid, uuid, public.task_status, timestamptz) from public, anon;
grant execute on function app.team_task_visible(uuid, uuid, uuid, uuid, public.task_status, timestamptz) to authenticated, service_role;

alter policy tasks_select on public.tasks
  using (
    app.can_read_record(organization_id, owner_id, team_id)
    or (created_by = (select auth.uid()) and app.is_member(organization_id))
    or ((organization_id, id) in (select r.organization_id, r.id from app.deputy_readable('task') r(organization_id, id)))
    -- TASK-07: an open team task nobody took yet, for the team's members
    or app.team_task_visible(organization_id, id, owner_id, team_id, status, deleted_at)
  );

-- The creator owns a new task, unless they gave it to a team they may give tasks to (TASK-07). The body of
-- app.default_owner() for tasks, which other tables keep using unchanged.
create or replace function app.tasks_default_owner() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.owner_id is null and auth.uid() is not null and current_user = 'authenticated' then
    if new.team_id is null then
      new.owner_id := auth.uid();
    elsif app.is_member(new.organization_id) and not app.may_assign_team_task(new.organization_id, new.team_id) then
      -- (someone outside the business gets RLS's plain refusal right after)
      raise exception 'not allowed to give a task to this team' using errcode = '42501', hint = 'task:team';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.tasks_default_owner() from public, anon;
grant execute on function app.tasks_default_owner() to authenticated;

create or replace trigger tasks_default_owner before insert on public.tasks
  for each row execute function app.tasks_default_owner();

-- a person's new team task: one notice to each active full-seat member of the team, not its creator
create or replace function app.notify_team_task() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.owner_id is not null or new.team_id is null or new.status <> 'open' or new.deleted_at is not null or auth.uid() is null then
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

create or replace trigger tasks_notify_team after insert on public.tasks
  for each row execute function app.notify_team_task();

create or replace function public.take_task(p_org uuid, p_task uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_task record;
  v_owner uuid;
begin
  if v_user is null or p_org is null or p_task is null
     or coalesce(app.membership_role(p_org) not in ('owner', 'admin', 'manager', 'member'), true)
     or not app.org_writable(p_org) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select t.id, t.owner_id, t.team_id, t.status, t.deleted_at into v_task
    from public.tasks t where t.organization_id = p_org and t.id = p_task;
  -- a task that is not a team task of the caller's (or is gone) is not theirs to take
  if v_task.id is null or v_task.team_id is null or not app.may_assign_team_task(p_org, v_task.team_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_task.owner_id = v_user then
    return jsonb_build_object('ok', true, 'owner_id', v_user);
  end if;
  if v_task.deleted_at is not null or v_task.status <> 'open' then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  if exists (select 1 from app.intake_callback_tasks ct where ct.organization_id = p_org and ct.task_id = p_task) then
    return jsonb_build_object('ok', false, 'reason', 'lead');
  end if;
  if v_task.owner_id is not null then
    return jsonb_build_object('ok', false, 'reason', 'taken');
  end if;

  -- first one wins: a second caller waits for the row lock, then finds an owner and updates nothing
  update public.tasks t set owner_id = v_user
   where t.organization_id = p_org and t.id = p_task and t.owner_id is null and t.status = 'open' and t.deleted_at is null
  returning t.owner_id into v_owner;
  if v_owner is null then
    select t.owner_id, t.status, t.deleted_at into v_task from public.tasks t where t.organization_id = p_org and t.id = p_task;
    if v_task.deleted_at is not null or v_task.status <> 'open' then
      return jsonb_build_object('ok', false, 'reason', 'closed');
    end if;
    return jsonb_build_object('ok', false, 'reason', 'taken');
  end if;
  -- the task stays the team's (a new owner would otherwise bring their own default team)
  update public.tasks t set team_id = v_task.team_id
   where t.organization_id = p_org and t.id = p_task and t.team_id is distinct from v_task.team_id;
  return jsonb_build_object('ok', true, 'owner_id', v_user);
end;
$$;
revoke all on function public.take_task(uuid, uuid) from public, anon;
grant execute on function public.take_task(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
