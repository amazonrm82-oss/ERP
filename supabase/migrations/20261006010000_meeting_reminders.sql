-- =============================================================================
-- 0100 Meeting reminders (CAL-06)
-- =============================================================================
-- "A reminder to the team participants, in the bell and by push, X minutes
-- before." The notification kind 'meeting_reminder' exists since 0068; its
-- check constraint is not touched here.
--
-- * meetings.reminder_minutes: how long before the start the team is reminded:
--   5, 15, 30, 60 or 1440 (a day), or null for no reminder. Default 15, also for
--   the meetings that exist already. Clients may write it (column grants, like
--   the other meeting fields); the meeting policies decide who.
-- * app.meeting_reminders_sent (schema app, RLS on, no grants): one row per
--   meeting, person and start time that was reminded. A person is reminded once
--   per start time: moving the meeting arms the reminder again, and someone
--   added after the reminder went out is reminded on the next run. Rows go with
--   their meeting (on delete cascade).
-- * app.send_meeting_reminders(): every planned meeting whose reminder time has
--   come and that has not started yet reminds its organizer and participants
--   who are active members, once each (title "תזכורת לפגישה: …", body the start
--   in the organization's time zone, linked to the meeting). Cancelled, held
--   and no-show meetings are skipped, and so are organizations that are
--   read-only or suspended (additions spec 22.9: reminders stop). A muted kind
--   is dropped and a bell-only kind is not pushed by the existing trigger
--   notifications_apply_settings.
-- * pg_cron job 'crm-meeting-reminders' (every minute, its own job so the
--   shared 'crm-notifications' job is unchanged) sends them and wakes the push
--   dispatcher when it sent any.
-- Every statement is safe to run twice.

alter table public.meetings add column if not exists reminder_minutes integer default 15;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'meetings_reminder_minutes' and conrelid = 'public.meetings'::regclass) then
    alter table public.meetings
      add constraint meetings_reminder_minutes check (reminder_minutes is null or reminder_minutes in (5, 15, 30, 60, 1440));
  end if;
end;
$$;

grant insert (reminder_minutes), update (reminder_minutes) on public.meetings to authenticated;

-- the scan: planned meetings with a reminder, by start
create index if not exists meetings_reminder_due_idx on public.meetings (starts_at)
  where status = 'planned' and reminder_minutes is not null;

create table if not exists app.meeting_reminders_sent (
  organization_id uuid not null,
  meeting_id      uuid not null,
  user_id         uuid not null,
  starts_at       timestamptz not null,
  sent_at         timestamptz not null default now(),
  primary key (meeting_id, user_id, starts_at),
  foreign key (organization_id, meeting_id) references public.meetings (organization_id, id) on delete cascade
);

alter table app.meeting_reminders_sent enable row level security;
revoke all on app.meeting_reminders_sent from public, anon, authenticated;

create or replace function app.send_meeting_reminders() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with due as (
    select m.organization_id, m.id, m.title, m.starts_at, m.owner_id,
           coalesce(o.timezone, 'Asia/Jerusalem') as tz
      from public.meetings m
      join public.organizations o on o.id = m.organization_id
     where m.status = 'planned'
       and m.reminder_minutes is not null
       -- the longest reminder is a day before
       and m.starts_at > now() and m.starts_at <= now() + interval '1 day'
       and m.starts_at - make_interval(mins => m.reminder_minutes) <= now()
       and app.org_writable(m.organization_id)
  ), people as (
    select d.organization_id, d.id as meeting_id, d.starts_at, d.owner_id as user_id
      from due d
     where d.owner_id is not null
    union
    select d.organization_id, d.id, d.starts_at, p.user_id
      from due d
      join public.meeting_participants p on p.organization_id = d.organization_id and p.meeting_id = d.id
  ), marked as (
    insert into app.meeting_reminders_sent (organization_id, meeting_id, user_id, starts_at)
    select pe.organization_id, pe.meeting_id, pe.user_id, pe.starts_at
      from people pe
     where exists (select 1 from public.memberships ms
                    where ms.organization_id = pe.organization_id and ms.user_id = pe.user_id and ms.status = 'active')
    on conflict do nothing
    returning organization_id, meeting_id, user_id
  )
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select k.organization_id, k.user_id, 'meeting_reminder', left('תזכורת לפגישה: ' || d.title, 200),
         to_char(d.starts_at at time zone d.tz, 'DD.MM.YYYY HH24:MI'), 'meeting', k.meeting_id
    from marked k
    join due d on d.id = k.meeting_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function app.send_meeting_reminders() from public, anon, authenticated;
grant execute on function app.send_meeting_reminders() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-meeting-reminders', '* * * * *',
      'select app.dispatch_push() where app.send_meeting_reminders() > 0;');
  end if;
end;
$$;
