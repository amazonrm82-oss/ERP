-- =============================================================================
-- 0068 Notification kinds (USR-06)
-- =============================================================================
-- One list of every kind of notification that waves 1 to 3 need, so that the
-- features that send them (REC-02, REC-03, CAL-06, SPD-01, later the quotes,
-- payments and response-time features) never touch the list again:
--
--   system             security notices; always arrives, cannot be muted
--   assigned           a record or task was given to you (existing)
--   task_reminder      a task reminder (existing)
--   inquiry            a lead or contact got in touch again (existing)
--   automation         a "notify" step of an automation (existing)
--   lead_new           a new lead came in (SPD-01, push with action buttons)
--   mention            someone mentioned you in a note (REC-02)
--   follow             a change on a record you follow (REC-03)
--   meeting_scheduled  someone put you in a meeting (sent from here on)
--   meeting_reminder   a meeting starts soon (CAL-06)
--   automation_failed  an automation run failed, to owners and admins (sent from here on)
--   quote              a quote was viewed or approved (later wave)
--   payment            a payment came in (later wave)
--   response_overdue   a new lead waited too long for an answer (CAP-10 / SPD-03)
--
-- * notifications.type is now checked against the list (it was free text), and
--   notification_settings accepts every kind but 'system'. Each check is
--   changed with one ALTER TABLE.
-- * meeting_scheduled: an active team member who is added to a planned, future
--   meeting by someone else, or made its organizer by someone else (not in a
--   handover), is told.
-- * automation_failed: when a run ends 'failed' or 'partial', every owner and
--   admin of the organization is told, at most once a day per automation
--   (read or not).
-- The kinds and their labels are mirrored in src/features/notifications/settings.ts.
-- Every statement is safe to run twice.

alter table public.notifications
  drop constraint if exists notifications_kinds,
  add constraint notifications_kinds check (type in (
    'system', 'assigned', 'task_reminder', 'inquiry', 'automation',
    'lead_new', 'mention', 'follow', 'meeting_scheduled', 'meeting_reminder',
    'automation_failed', 'quote', 'payment', 'response_overdue'));

alter table public.notification_settings
  drop constraint if exists notification_settings_kinds,
  add constraint notification_settings_kinds check (
    muted <@ array['assigned', 'task_reminder', 'inquiry', 'automation',
                   'lead_new', 'mention', 'follow', 'meeting_scheduled', 'meeting_reminder',
                   'automation_failed', 'quote', 'payment', 'response_overdue']
    and no_push <@ array['assigned', 'task_reminder', 'inquiry', 'automation',
                         'lead_new', 'mention', 'follow', 'meeting_scheduled', 'meeting_reminder',
                         'automation_failed', 'quote', 'payment', 'response_overdue']);

-- ----------------------------------------------------------------------------
-- meeting_scheduled
-- ----------------------------------------------------------------------------
-- Title and start time of a meeting, in the organization's time zone, and
-- whether to tell p_user: a planned meeting that has not started, and no
-- unread notice about it yet (the organizer may also be a participant).
create or replace function app.meeting_notice(p_org uuid, p_meeting uuid, p_user uuid, out title text, out body text, out notify boolean)
language sql stable security definer
set search_path = ''
as $$
  select left('נקבעה לכם פגישה: ' || mt.title, 200),
         to_char(mt.starts_at at time zone coalesce(o.timezone, 'Asia/Jerusalem'), 'DD.MM.YYYY HH24:MI'),
         mt.status = 'planned' and mt.starts_at > now()
           and not exists (select 1 from public.notifications n
                            where n.user_id = p_user and n.organization_id = p_org and n.type = 'meeting_scheduled'
                              and n.entity_id = p_meeting and n.read_at is null)
    from public.meetings mt
    join public.organizations o on o.id = mt.organization_id
   where mt.organization_id = p_org and mt.id = p_meeting
$$;

-- a team member added to a meeting by someone else
create or replace function app.notify_meeting_participant() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_notice record;
begin
  if new.user_id is not distinct from auth.uid() then
    return null;
  end if;
  -- a suspended member is not told
  if not exists (select 1 from public.memberships m
                  where m.organization_id = new.organization_id and m.user_id = new.user_id and m.status = 'active') then
    return null;
  end if;
  select * into v_notice from app.meeting_notice(new.organization_id, new.meeting_id, new.user_id);
  if not coalesce(v_notice.notify, false) then
    return null;
  end if;
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  values (new.organization_id, new.user_id, 'meeting_scheduled', v_notice.title, v_notice.body, 'meeting', new.meeting_id);
  return null;
end;
$$;

-- a team member made the organizer by someone else (not in a handover, which sends one summary)
create or replace function app.notify_meeting_organizer() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_notice record;
begin
  if new.owner_id is null or new.owner_id is not distinct from auth.uid() then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.owner_id is not distinct from old.owner_id then
    return null;
  end if;
  if current_setting('app.bulk_transfer', true) = 'on' then
    return null;
  end if;
  select * into v_notice from app.meeting_notice(new.organization_id, new.id, new.owner_id);
  if not coalesce(v_notice.notify, false) then
    return null;
  end if;
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  values (new.organization_id, new.owner_id, 'meeting_scheduled', v_notice.title, v_notice.body, 'meeting', new.id);
  return null;
end;
$$;

revoke all on function app.meeting_notice(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function app.notify_meeting_participant() from public, anon, authenticated;
revoke all on function app.notify_meeting_organizer() from public, anon, authenticated;

create or replace trigger meeting_participants_notify after insert on public.meeting_participants
  for each row execute function app.notify_meeting_participant();
create or replace trigger meetings_notify_organizer after insert or update of owner_id on public.meetings
  for each row execute function app.notify_meeting_organizer();

-- ----------------------------------------------------------------------------
-- automation_failed
-- ----------------------------------------------------------------------------
-- app.execute_automation() logs a run as 'success' first and sets its final
-- status after the steps ran; this fires on that last update.
create or replace function app.notify_automation_failed() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  select a.name into v_name from public.automations a
   where a.organization_id = new.organization_id and a.id = new.automation_id;
  if v_name is null then
    return null;
  end if;
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select new.organization_id, m.user_id, 'automation_failed',
         left(case when new.status = 'failed' then 'אוטומציה נכשלה: ' else 'אוטומציה נכשלה בחלקה: ' end || v_name, 200),
         'אפשר לראות מה לא עבד ביומן ההרצות של האוטומציה.',
         'automation', new.automation_id
    from public.memberships m
   where m.organization_id = new.organization_id and m.status = 'active' and m.role in ('owner', 'admin')
     -- at most once a day per rule and person, read or not (a broken rule fails on every event)
     and not exists (select 1 from public.notifications n
                      where n.user_id = m.user_id and n.organization_id = new.organization_id
                        and n.type = 'automation_failed' and n.entity_id = new.automation_id
                        and n.created_at > now() - interval '1 day');
  return null;
end;
$$;

revoke all on function app.notify_automation_failed() from public, anon, authenticated;

create or replace trigger automation_runs_notify_failed after update of status on public.automation_runs
  for each row when (new.status in ('failed', 'partial') and old.status is distinct from new.status)
  execute function app.notify_automation_failed();
