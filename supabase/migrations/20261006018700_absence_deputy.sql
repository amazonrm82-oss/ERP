-- =============================================================================
-- Absence with a deputy (HEB-08)
-- =============================================================================
-- Owner's decision of 14 October 2026 (DECISIONS.md "ממלא מקום בהיעדרות"):
-- * public.member_leaves (CAP-09, 0161) gets
--   - kind: null (a plain leave, as before) | 'reserve' (במילואים) | 'vacation' (בחופשה);
--   - deputy_id: who stands in, a composite FK to the membership (organization_id,
--     deputy_id), set null when that membership is removed. The same writers as
--     before (app.member_hours_editable); column grants below.
--   Trigger member_leaves_deputy_check (definer): the deputy is an active member who
--   is not a viewer (hint member_leaves:deputy_inactive), not the person themselves
--   (member_leaves:deputy_self), and has no leave of their own on any of these days
--   (member_leaves:deputy_absent). It starts with the quota-trigger guard: a caller
--   who may not write this leave gets RLS's plain 42501 and learns nothing.
--   A deputy who later adds a leave of their own is not refused; on those days
--   app.deputy_for() does not return them (no chain).
-- * "Absent" = on a leave at that moment (any kind), read in the person's zone,
--   exactly as app.member_in_hours() reads a leave (app.member_on_leave()).
-- * app.deputy_for(org, user, at): the deputy of the person's leave at that moment,
--   when usable: an active member, not a viewer, not on leave then. Otherwise null.
--   Working hours are NOT asked here (a lead given to a fixed owner never waited for
--   hours either); the round robin asks them on its own (below).
-- * New leads (owner, point 1):
--   - round robin (app.next_lead_turn / app.next_lead_owner; used by intake_submit,
--     the rotation-waiting job, the automation round robin and the CAP-10 pass-on):
--     an absent member whose deputy is usable and in hours keeps their turn and the
--     lead goes to the deputy; an absent member with no usable deputy is skipped, as
--     before. The absent member's turn is stamped, never the deputy's.
--   - a form's fixed owner (intake_submit): absent -> the deputy; no usable deputy ->
--     no owner, the SPD-01 route (point 5: no chain).
--   - an automation's "assign to a person" on a lead goes through the same rule
--     (app.assign_lead_owner_auto, owner 14 October 2026): absent with no usable deputy
--     -> no owner, the SPD-01 notices, and back to the person on their return; the
--     step is logged 'ok' with a warning.
--   - app.check_lead_responses (SPD-03 pass-on): picks through app.next_lead_turn; a
--     picked previous owner (the deputy included) is skipped and the stamp that is put
--     back is the one of whoever's turn it was.
-- * Tasks (point 2): never moved. During the absence (business zone dates) the deputy
--   reads the absent person's tasks that are open or changed since the absence began
--   (so a task they completed stays in view), may update the open ones (complete,
--   snooze, edit), and may not change their owner or team (trigger tasks_deputy_guard,
--   hint task:deputy_owner) nor delete them (unchanged rules). app.send_task_reminders()
--   also reminds the deputy (a notification only).
-- * Reading (point 3), computed at read time, never stored: during the absence
--   (business zone dates) the deputy also reads (a) the leads, contacts, companies and
--   deals linked by the absent person's open tasks that the absent person may read
--   (app.user_can_read_record) and (b) the absent person's open
--   leads nobody else answered yet (the waiting-leads rule, src/features/leads/waiting.ts:
--   open status, not converted, not imported, not in the bin, no non-private contact
--   entry logged by a person other than the deputy; the deputy's own call does not
--   hide the lead from them). app.can_read_record() is NOT changed (it has no record
--   id): the select policies of leads, contacts, companies, deals and tasks add
--   "(organization_id, id) in (select ... from app.deputy_readable(type))", an
--   uncorrelated sub-select the planner runs once per query (a hashed SubPlan); for
--   someone who covers for nobody it is one indexed look-up of member_leaves.deputy_id.
--   Timelines, files, deal contacts and contact channels follow, as their policies
--   ask the record policies. app.user_deputy_reads() is the same rule for a given
--   user (beside app.user_can_read_record(), which stays the mirror of
--   app.can_read_record()); mentions use both, so a deputy can be mentioned there.
-- * Existing records stay in the absent person's name (point 4).
-- The change is split into four files, applied in name order: this one (tables,
-- helpers, policies, the return job), _intake (intake_submit), _assign (notify_assignment,
-- run_automation_actions, app.assign_lead_owner_auto) and _followups (check_lead_responses,
-- send_task_reminders, mentions).
-- Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- Columns
-- ----------------------------------------------------------------------------
alter table public.member_leaves add column if not exists kind text;
alter table public.member_leaves add column if not exists deputy_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.member_leaves'::regclass and conname = 'member_leaves_kind_check') then
    alter table public.member_leaves add constraint member_leaves_kind_check
      check (kind is null or kind in ('reserve', 'vacation'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.member_leaves'::regclass and conname = 'member_leaves_deputy_fkey') then
    alter table public.member_leaves add constraint member_leaves_deputy_fkey
      foreign key (organization_id, deputy_id) references public.memberships (organization_id, user_id)
      on delete set null (deputy_id);
  end if;
end;
$$;

create index if not exists member_leaves_deputy_idx on public.member_leaves (deputy_id, ends_on) where deputy_id is not null;

grant insert (kind, deputy_id), update (kind, deputy_id) on public.member_leaves to authenticated;

-- ----------------------------------------------------------------------------
-- Who may be the deputy
-- ----------------------------------------------------------------------------
create or replace function app.member_leaves_deputy_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.deputy_id is null then
    return new;
  end if;
  -- a caller who may not write this leave is refused by RLS after this trigger, with nothing learned here
  if auth.uid() is not null and not app.member_hours_editable(new.organization_id, new.user_id) then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.deputy_id is not distinct from old.deputy_id
     and new.starts_on = old.starts_on and new.ends_on = old.ends_on then
    return new;
  end if;
  if new.deputy_id = new.user_id then
    raise exception 'a member is not their own deputy' using errcode = 'P0001', hint = 'member_leaves:deputy_self';
  end if;
  if not exists (select 1 from public.memberships m
                  where m.organization_id = new.organization_id and m.user_id = new.deputy_id
                    and m.status = 'active' and m.role <> 'viewer') then
    raise exception 'the deputy is not an active member' using errcode = 'P0001', hint = 'member_leaves:deputy_inactive';
  end if;
  if exists (select 1 from public.member_leaves l
              where l.organization_id = new.organization_id and l.user_id = new.deputy_id
                and l.starts_on <= new.ends_on and l.ends_on >= new.starts_on) then
    raise exception 'the deputy is away on some of these days' using errcode = 'P0001', hint = 'member_leaves:deputy_absent';
  end if;
  return new;
end;
$$;
revoke all on function app.member_leaves_deputy_check() from public, anon, authenticated;

create or replace trigger member_leaves_deputy_check before insert or update of deputy_id, starts_on, ends_on on public.member_leaves
  for each row execute function app.member_leaves_deputy_check();

-- ----------------------------------------------------------------------------
-- Absent, and the deputy
-- ----------------------------------------------------------------------------

-- On a leave at that moment? The person's zone, else the business's (the rule of
-- app.member_in_hours()).
create or replace function app.member_on_leave(p_org uuid, p_user uuid, p_at timestamptz) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.member_leaves l
      join public.organizations o on o.id = l.organization_id
      left join public.profiles p on p.id = l.user_id
     where l.organization_id = p_org and l.user_id = p_user
       and (p_at at time zone app.intake_zone(coalesce(p.timezone, o.timezone)))::date between l.starts_on and l.ends_on)
$$;
revoke all on function app.member_on_leave(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function app.member_on_leave(uuid, uuid, timestamptz) to service_role;

-- The usable deputy of the person's leave at that moment, else null. Usable: an
-- active member, not a viewer, not on leave then. No chain: the deputy's own
-- deputy is never asked. Hours are not asked (see the header).
create or replace function app.deputy_for(p_org uuid, p_user uuid, p_at timestamptz) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select l.deputy_id
    from public.member_leaves l
    join public.organizations o on o.id = l.organization_id
    left join public.profiles p on p.id = l.user_id
    join public.memberships m on m.organization_id = l.organization_id and m.user_id = l.deputy_id
   where l.organization_id = p_org and l.user_id = p_user and l.deputy_id is not null
     and l.deputy_id <> p_user
     and (p_at at time zone app.intake_zone(coalesce(p.timezone, o.timezone)))::date between l.starts_on and l.ends_on
     and m.status = 'active' and m.role <> 'viewer'
     and not app.member_on_leave(p_org, l.deputy_id, p_at)
   order by l.starts_on desc, l.id
   limit 1
$$;
revoke all on function app.deputy_for(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function app.deputy_for(uuid, uuid, timestamptz) to service_role;

-- The round robin's deputy: the usable deputy of an absent member, when that
-- deputy is also in working hours (the rotation never gives a lead outside hours).
create or replace function app.rotation_deputy(p_org uuid, p_user uuid, p_at timestamptz) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select x.deputy
    from (select app.deputy_for(p_org, p_user, p_at) as deputy) x
   where x.deputy is not null and app.member_in_hours(p_org, x.deputy, p_at)
$$;
revoke all on function app.rotation_deputy(uuid, uuid, timestamptz) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Round robin
-- ----------------------------------------------------------------------------

-- Whose turn it is (turn_user, whose last_lead_assigned_at is stamped), who gets
-- the lead (owner_id: that member, or the deputy of an absent one) and the turn's
-- stamp before this pick (turn_was, for callers that put a skipped turn back).
-- The CAP-09 rule otherwise unchanged: an active, available member with a full
-- seat (of the team, when one is given), in hours and not on leave, who got a
-- lead the longest time ago; an absent one counts when their deputy is usable
-- and in hours. Locks the member row of the turn (skip locked).
create or replace function app.next_lead_turn(
  p_org uuid, p_team uuid, p_at timestamptz,
  out turn_user uuid, out owner_id uuid, out turn_was timestamptz
)
language plpgsql security definer
set search_path = ''
as $$
begin
  select m.user_id, m.last_lead_assigned_at,
         case when app.member_in_hours(p_org, m.user_id, p_at) then m.user_id
              else app.rotation_deputy(p_org, m.user_id, p_at) end
    into turn_user, turn_was, owner_id
    from public.memberships m
   where m.organization_id = p_org
     and m.status = 'active' and m.is_available and m.role <> 'viewer' and m.seat_type = 'full'
     and (p_team is null or exists (
       select 1 from public.team_members tm where tm.team_id = p_team and tm.user_id = m.user_id))
     and (app.member_in_hours(p_org, m.user_id, p_at)
          or app.rotation_deputy(p_org, m.user_id, p_at) is not null)
   order by m.last_lead_assigned_at nulls first, m.created_at
   limit 1
   for update of m skip locked;
  if turn_user is not null then
    update public.memberships set last_lead_assigned_at = now()
     where organization_id = p_org and user_id = turn_user;
  end if;
end;
$$;
revoke all on function app.next_lead_turn(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function app.next_lead_turn(uuid, uuid, timestamptz) to service_role;

-- The next owner in the rotation at a moment (CAP-09), now through app.next_lead_turn():
-- the member whose turn it is, or the deputy of an absent one. Null when nobody qualifies.
create or replace function app.next_lead_owner(p_org uuid, p_team uuid, p_at timestamptz) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  select t.owner_id into v_user from app.next_lead_turn(p_org, p_team, p_at) t;
  return v_user;
end;
$$;
revoke all on function app.next_lead_owner(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function app.next_lead_owner(uuid, uuid, timestamptz) to service_role;

-- ----------------------------------------------------------------------------
-- What a deputy reads
-- ----------------------------------------------------------------------------

-- The rows a user reads as a deputy, by type: 'lead' | 'contact' | 'company' |
-- 'deal' (linked by an open task of the absent person; leads also the absent
-- person's open, unanswered ones), 'task' (the absent person's tasks, open or
-- changed since the absence began), 'task_open' (the open ones: what the deputy
-- may update). Absences that cover today in the business's zone, of a business
-- where the user is an active member; p_session also asks app.membership_role()
-- for the signed-in caller (two-step rule, closed business).
create or replace function app.deputy_records(p_user uuid, p_type text, p_session boolean)
returns table (organization_id uuid, id uuid)
language sql stable security definer
set search_path = ''
as $$
  with absences as (
    select l.organization_id, l.user_id,
           (l.starts_on::timestamp at time zone app.intake_zone(o.timezone)) as starts_at
      from public.member_leaves l
      join public.organizations o on o.id = l.organization_id
      join public.memberships m on m.organization_id = l.organization_id and m.user_id = l.deputy_id
      -- the absent person is still an active member
      join public.memberships ma on ma.organization_id = l.organization_id and ma.user_id = l.user_id
     where p_user is not null and l.deputy_id = p_user and l.user_id <> p_user
       and m.status = 'active' and m.role <> 'viewer'
       and ma.status = 'active'
       and (now() at time zone app.intake_zone(o.timezone))::date between l.starts_on and l.ends_on
       and (not p_session or app.membership_role(l.organization_id) is not null)
  ), open_tasks as (
    select t.organization_id, a.user_id, t.lead_id, t.contact_id, t.company_id, t.deal_id
      from absences a
      join public.tasks t on t.organization_id = a.organization_id and t.owner_id = a.user_id
     where p_type in ('lead', 'contact', 'company', 'deal')
       and t.status = 'open' and t.deleted_at is null
  )
  -- (a) the records the absent person's open tasks link, only those the absent person
  -- may read themselves (a task on a record they cannot see opens nothing to the deputy)
  select r.organization_id, r.id
    from open_tasks k
    join public.leads r on r.organization_id = k.organization_id and r.id = k.lead_id
   where p_type = 'lead' and app.user_can_read_record(r.organization_id, k.user_id, r.owner_id, r.team_id)
  union
  select r.organization_id, r.id
    from open_tasks k
    join public.contacts r on r.organization_id = k.organization_id and r.id = k.contact_id
   where p_type = 'contact' and app.user_can_read_record(r.organization_id, k.user_id, r.owner_id, r.team_id)
  union
  select r.organization_id, r.id
    from open_tasks k
    join public.companies r on r.organization_id = k.organization_id and r.id = k.company_id
   where p_type = 'company' and app.user_can_read_record(r.organization_id, k.user_id, r.owner_id, r.team_id)
  union
  select r.organization_id, r.id
    from open_tasks k
    join public.deals r on r.organization_id = k.organization_id and r.id = k.deal_id
   where p_type = 'deal' and app.user_can_read_record(r.organization_id, k.user_id, r.owner_id, r.team_id)
  union
  select l.organization_id, l.id
    from absences a
    join public.leads l on l.organization_id = a.organization_id and l.owner_id = a.user_id
   where p_type = 'lead'
     and l.deleted_at is null and l.converted_at is null and l.import_job_id is null
     and exists (select 1 from public.lead_statuses s
                  where s.organization_id = l.organization_id and s.id = l.status_id and s.kind = 'open')
     and not exists (select 1 from public.activities x
                      where x.organization_id = l.organization_id and x.lead_id = l.id
                        and x.created_by is not null and x.created_by <> p_user
                        and x.type = any (app.contact_types()) and not x.is_private)
  union
  select t.organization_id, t.id
    from absences a
    join public.tasks t on t.organization_id = a.organization_id and t.owner_id = a.user_id
   where t.deleted_at is null
     and ((p_type = 'task' and (t.status = 'open' or t.updated_at >= a.starts_at))
          or (p_type = 'task_open' and t.status = 'open'))
$$;
revoke all on function app.deputy_records(uuid, text, boolean) from public, anon, authenticated;

-- The signed-in caller's deputy rows, for the select and update policies.
create or replace function app.deputy_readable(p_type text) returns table (organization_id uuid, id uuid)
language sql stable security definer
set search_path = ''
as $$
  select r.organization_id, r.id from app.deputy_records(auth.uid(), p_type, true) r
$$;
revoke all on function app.deputy_readable(text) from public, anon;
grant execute on function app.deputy_readable(text) to authenticated, service_role;

-- The same rule for a given user (notifications, mentions): read beside
-- app.user_can_read_record(), as app.deputy_readable() is read beside app.can_read_record().
create or replace function app.user_deputy_reads(p_org uuid, p_user uuid, p_type text, p_id uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_org is not null and p_id is not null and exists (
    select 1 from app.deputy_records(p_user, p_type, false) r where r.organization_id = p_org and r.id = p_id)
$$;
revoke all on function app.user_deputy_reads(uuid, uuid, text, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Policies (alter: they exist since 0004)
-- ----------------------------------------------------------------------------
alter policy leads_select on public.leads
  using (app.can_read_record(organization_id, owner_id, team_id)
         or (organization_id, id) in (select r.organization_id, r.id from app.deputy_readable('lead') r));
alter policy contacts_select on public.contacts
  using (app.can_read_record(organization_id, owner_id, team_id)
         or (organization_id, id) in (select r.organization_id, r.id from app.deputy_readable('contact') r));
alter policy companies_select on public.companies
  using (app.can_read_record(organization_id, owner_id, team_id)
         or (organization_id, id) in (select r.organization_id, r.id from app.deputy_readable('company') r));
alter policy deals_select on public.deals
  using (app.can_read_record(organization_id, owner_id, team_id)
         or (organization_id, id) in (select r.organization_id, r.id from app.deputy_readable('deal') r));

alter policy tasks_select on public.tasks
  using (app.can_read_record(organization_id, owner_id, team_id)
         or (created_by = (select auth.uid()) and app.is_member(organization_id))
         or (organization_id, id) in (select r.organization_id, r.id from app.deputy_readable('task') r));
alter policy tasks_update on public.tasks
  using (app.can_edit_record(organization_id, owner_id, team_id)
         or (created_by = (select auth.uid()) and app.can_write(organization_id))
         or (app.can_write(organization_id)
             and (organization_id, id) in (select r.organization_id, r.id from app.deputy_readable('task_open') r)))
  with check (app.can_write(organization_id));

-- A deputy completes, snoozes and edits the absent person's open tasks but never
-- hands them over: changing the owner or the team needs the rights a person had
-- before HEB-08 (security invoker: current_user tells a browser write).
create or replace function app.tasks_deputy_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if (new.owner_id is distinct from old.owner_id or new.team_id is distinct from old.team_id)
     and not app.can_edit_record(old.organization_id, old.owner_id, old.team_id)
     and not (old.created_by = auth.uid() and app.can_write(old.organization_id)) then
    raise exception 'a deputy does not hand the task over' using errcode = '42501', hint = 'task:deputy_owner';
  end if;
  return new;
end;
$$;
revoke all on function app.tasks_deputy_guard() from public, anon, authenticated;

create or replace trigger tasks_deputy_guard before update of owner_id, team_id on public.tasks
  for each row execute function app.tasks_deputy_guard();

-- ----------------------------------------------------------------------------
-- A form lead that came in unowned because its fixed owner was away (owner, 14 October 2026)
-- ----------------------------------------------------------------------------
-- intake_submit notes it here when the form's owner is absent with no usable deputy
-- (the lead takes the SPD-01 route meanwhile). pg_cron crm-absence-return (every
-- minute, app.return_absence_leads()) gives a lead still nobody's to that person once
-- they are back: an active member who is not a viewer, no longer on leave and inside
-- their CAP-09 working hours (the person's own, else the business's; with no hours set
-- anywhere, from the first minute of the return day in their zone), as a new lead
-- ('lead_new', app.absence_return around the update). Only while the lead has no
-- owner, is open, not converted and not in the bin; a lead someone took meanwhile is
-- left alone. Given up after 120 days (a leave lasts at most a year, but a lead that
-- waited four months is no longer new), or when the person left the business. Rows
-- are never removed: resolved_at and outcome mark them done (taken | closed | returned
-- | member_gone | expired). Fair and bounded like crm-rotation-waiting: at most
-- app.rotation_waiting_per_org() rows per organization and app.rotation_waiting_limit()
-- per run, each in its own exception block. Schema app: RLS on, no policies, no grants.
create table if not exists app.absence_waiting_leads (
  lead_id         uuid primary key references public.leads (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  form_id         uuid,
  absent_user_id  uuid not null,
  created_at      timestamptz not null default now(),
  next_check_at   timestamptz not null default now(),
  resolved_at     timestamptz,
  outcome         text,
  constraint absence_waiting_leads_outcome check (outcome is null or outcome in ('taken', 'closed', 'returned', 'member_gone', 'expired'))
);
create index if not exists absence_waiting_leads_due_idx on app.absence_waiting_leads (next_check_at) where resolved_at is null;
alter table app.absence_waiting_leads enable row level security;
revoke all on app.absence_waiting_leads from public, anon, authenticated;

create or replace function app.return_absence_leads() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_lead record;
  v_done integer := 0;
begin
  for v_row in
    select d.lead_id, d.organization_id, d.absent_user_id, d.created_at
      from (
        select w.lead_id, w.organization_id, w.absent_user_id, w.created_at, w.next_check_at,
               row_number() over (partition by w.organization_id order by w.next_check_at, w.created_at) as n
          from app.absence_waiting_leads w
         where w.resolved_at is null and w.next_check_at <= now()
      ) d
     where d.n <= app.rotation_waiting_per_org()
     order by d.next_check_at, d.created_at
     limit app.rotation_waiting_limit()
  loop
    begin
      select l.owner_id, l.deleted_at, l.converted_at, s.kind as status_kind into v_lead
        from public.leads l
        join public.lead_statuses s on s.organization_id = l.organization_id and s.id = l.status_id
       where l.organization_id = v_row.organization_id and l.id = v_row.lead_id
       for update of l;
      if not found or v_lead.deleted_at is not null or v_lead.converted_at is not null or v_lead.status_kind <> 'open' then
        update app.absence_waiting_leads set resolved_at = now(), outcome = 'closed' where lead_id = v_row.lead_id;
      elsif v_lead.owner_id is not null then
        update app.absence_waiting_leads set resolved_at = now(), outcome = 'taken' where lead_id = v_row.lead_id;
      elsif v_row.created_at < now() - interval '120 days' then
        update app.absence_waiting_leads set resolved_at = now(), outcome = 'expired' where lead_id = v_row.lead_id;
      elsif not exists (select 1 from public.memberships m
                         where m.organization_id = v_row.organization_id and m.user_id = v_row.absent_user_id
                           and m.status = 'active' and m.role <> 'viewer') then
        update app.absence_waiting_leads set resolved_at = now(), outcome = 'member_gone' where lead_id = v_row.lead_id;
      elsif not app.org_writable(v_row.organization_id) then
        update app.absence_waiting_leads set next_check_at = now() + interval '15 minutes' where lead_id = v_row.lead_id;
      elsif app.member_on_leave(v_row.organization_id, v_row.absent_user_id, now()) then
        update app.absence_waiting_leads set next_check_at = now() + interval '10 minutes' where lead_id = v_row.lead_id;
      elsif not app.member_in_hours(v_row.organization_id, v_row.absent_user_id, now()) then
        update app.absence_waiting_leads set next_check_at = now() + interval '5 minutes' where lead_id = v_row.lead_id;
      else
        -- told as a new lead (app.notify_assignment()), not as an assignment
        perform set_config('app.absence_return', 'on', true);
        update public.leads set owner_id = v_row.absent_user_id
         where organization_id = v_row.organization_id and id = v_row.lead_id and owner_id is null;
        perform set_config('app.absence_return', '', true);
        update app.absence_waiting_leads set resolved_at = now(), outcome = 'returned' where lead_id = v_row.lead_id;
        v_done := v_done + 1;
      end if;
    exception when others then
      -- this row's changes are rolled back; look at it again later (never stops the run), go on with the others
      begin
        update app.absence_waiting_leads set next_check_at = now() + interval '10 minutes' where lead_id = v_row.lead_id;
      exception when others then
        null;
      end;
    end;
  end loop;
  return v_done;
end;
$$;
revoke all on function app.return_absence_leads() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-absence-return', '* * * * *', 'select app.return_absence_leads();');
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- An automatic assignment of a fixed person (owner, 14 October 2026, DECISIONS.md
-- "שיוך אוטומטי לעובד נעדר בלי ממלא מקום"): one rule for every automatic assigner
-- ----------------------------------------------------------------------------
-- app.auto_lead_owner(org, user, at): the person when present; when absent, their
-- usable deputy (app.deputy_for); when absent with no usable deputy, no owner and
-- absent_user = the person, so the caller leaves the lead unowned (SPD-01 notices) and
-- notes it with app.lead_waits_for_absent() for crm-absence-return. Used by
-- intake_submit (a form's fixed owner) and app.assign_lead_owner_auto() (automations).
-- Defined here, before the files that call it, so every file works when applied in order.
create or replace function app.auto_lead_owner(
  p_org uuid, p_user uuid, p_at timestamptz,
  out owner_id uuid, out absent_user uuid
)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if p_org is null or p_user is null then
    return;
  end if;
  if not app.member_on_leave(p_org, p_user, coalesce(p_at, now())) then
    owner_id := p_user;
    return;
  end if;
  owner_id := app.deputy_for(p_org, p_user, coalesce(p_at, now()));
  if owner_id is null then
    absent_user := p_user;
  end if;
end;
$$;
revoke all on function app.auto_lead_owner(uuid, uuid, timestamptz) from public, anon, authenticated;

-- A lead left unowned because its person is away: handed to them on their return
-- (app.return_absence_leads()) unless someone takes it first. form_id may be null.
create or replace function app.lead_waits_for_absent(p_org uuid, p_lead uuid, p_form uuid, p_absent uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_org is null or p_lead is null or p_absent is null then
    return;
  end if;
  insert into app.absence_waiting_leads (lead_id, organization_id, form_id, absent_user_id)
  values (p_lead, p_org, p_form, p_absent) on conflict do nothing;
end;
$$;
revoke all on function app.lead_waits_for_absent(uuid, uuid, uuid, uuid) from public, anon, authenticated;
