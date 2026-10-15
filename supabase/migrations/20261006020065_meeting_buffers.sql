-- =============================================================================
-- 0200i Buffers on the meeting itself (CAL-10, owner's decision of 15 October 2026)
-- =============================================================================
-- "זמן פנוי: להעתיק לפגישה?" The buffer before and after a meeting is copied onto the
-- meeting when it is booked, from any source (the meeting form, the calendar, a series, later
-- the booking page). A later change to the meeting type affects only new meetings; the
-- meeting's own buffers are what availability and conflicts check.
-- * meetings.buffer_before_minutes / buffer_after_minutes: 0..240 like the type's, NOT NULL
--   after the fill below; column grants (insert, update).
-- * Trigger meetings_buffers (before insert or update of meeting_type_id or the buffers, every
--   writer, security invoker: it only reads the meeting's own type):
--   - insert: a buffer not sent (null) is the type's, 0 without a type;
--   - update: a buffer set to null is the current type's, 0 without a type;
--   - a change to ANOTHER type copies that type's buffers, except a buffer the same update
--     changes (the person's own value wins); clearing the type, or the type being deleted
--     (its foreign key clears the link), keeps the buffers the meeting has.
-- * public.meeting_busy: 0197's body, reading the meeting's own buffers (no join to the type).
--   The 240-minute first cut stays, tied to both checks by tests/db/99-meeting-types.
-- * public.create_meeting_series: 020040's body, passing buffer_before_minutes /
--   buffer_after_minutes from p_meeting (absent = the type's).
-- * app.notify_meeting_participant: 020040's body; the "one notice per series" skip only looks at
--   an unread notice made in the last 15 minutes (CAL-09 review), so a person invited to the
--   series later is told.
-- * The one-time fill: existing meetings get their current type's buffers (0 without a type),
--   only where a buffer is still null; then the columns become NOT NULL.
--   How many rows it touches: select count(*) from public.meetings
--     where buffer_before_minutes is null or buffer_after_minutes is null;
-- No plan key (core). No delete, no drop. Safe to run twice.

alter table public.meetings add column if not exists buffer_before_minutes integer;
alter table public.meetings add column if not exists buffer_after_minutes integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.meetings'::regclass and conname = 'meetings_buffer_before_minutes_check') then
    alter table public.meetings add constraint meetings_buffer_before_minutes_check check (buffer_before_minutes between 0 and 240);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.meetings'::regclass and conname = 'meetings_buffer_after_minutes_check') then
    alter table public.meetings add constraint meetings_buffer_after_minutes_check check (buffer_after_minutes between 0 and 240);
  end if;
end;
$$;

grant insert (buffer_before_minutes, buffer_after_minutes) on public.meetings to authenticated;
grant update (buffer_before_minutes, buffer_after_minutes) on public.meetings to authenticated;

comment on column public.meetings.buffer_before_minutes is 'CAL-10: free time kept before the meeting, copied from its type when booked; 0..240.';
comment on column public.meetings.buffer_after_minutes is 'CAL-10: free time kept after the meeting, copied from its type when booked; 0..240.';

create or replace function app.meetings_buffers() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_before integer;
  v_after integer;
begin
  if new.meeting_type_id is not null then
    select ty.buffer_before_minutes, ty.buffer_after_minutes into v_before, v_after
      from public.meeting_types ty
     where ty.organization_id = new.organization_id and ty.id = new.meeting_type_id;
  end if;
  if tg_op = 'UPDATE' and new.meeting_type_id is not null and new.meeting_type_id is distinct from old.meeting_type_id then
    -- another type: its buffers, unless this update sets the buffer itself
    if new.buffer_before_minutes is not distinct from old.buffer_before_minutes then
      new.buffer_before_minutes := coalesce(v_before, new.buffer_before_minutes);
    end if;
    if new.buffer_after_minutes is not distinct from old.buffer_after_minutes then
      new.buffer_after_minutes := coalesce(v_after, new.buffer_after_minutes);
    end if;
  end if;
  new.buffer_before_minutes := coalesce(new.buffer_before_minutes, v_before, 0);
  new.buffer_after_minutes := coalesce(new.buffer_after_minutes, v_after, 0);
  return new;
end;
$$;
revoke all on function app.meetings_buffers() from public, anon, authenticated;

create or replace trigger meetings_buffers
  before insert or update of meeting_type_id, buffer_before_minutes, buffer_after_minutes on public.meetings
  for each row execute function app.meetings_buffers();

-- ----------------------------------------------------------------------------
-- Busy times read the meeting's own buffers (0197's body)
-- ----------------------------------------------------------------------------
create or replace function public.meeting_busy(
  p_org uuid,
  p_users uuid[],
  p_from timestamptz,
  p_to timestamptz,
  p_exclude uuid default null
) returns table (user_id uuid, meeting_id uuid, title text, starts_at timestamptz, ends_at timestamptz,
                 busy_from timestamptz, busy_to timestamptz)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if p_org is null or not app.is_member(p_org) or not app.can_write(p_org) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;
  if p_users is null or p_from is null or p_to is null
     or cardinality(p_users) > 51 or p_to <= p_from or p_to > p_from + interval '15 days' then
    raise exception 'invalid arguments' using errcode = '22023';
  end if;

  return query
  with people as (
    select distinct m.user_id
    from public.memberships m
    where m.organization_id = p_org
      and m.status = 'active'
      and m.user_id = any (p_users)
  ),
  candidates as (
    -- the largest buffer is 240 minutes (the buffer checks on meetings and meeting_types; tests/db/99-meeting-types
    -- keeps them equal): a wider first cut keeps the index on starts_at in use
    -- CAL-10: the meeting's own buffers, copied from its type when it was booked
    select mt.id, mt.owner_id, mt.starts_at, mt.ends_at,
           mt.starts_at - make_interval(mins => coalesce(mt.buffer_before_minutes, 0)) as busy_from,
           mt.ends_at + make_interval(mins => coalesce(mt.buffer_after_minutes, 0)) as busy_to
    from public.meetings mt
    where mt.organization_id = p_org
      and mt.status not in ('cancelled', 'no_show')
      and mt.starts_at < p_to + interval '240 minutes' and mt.ends_at > p_from - interval '240 minutes'
  ),
  busy as (
    select c.* from candidates c where c.busy_from < p_to and c.busy_to > p_from
  ),
  taken as (
    -- organized
    select b.owner_id as user_id, b.id as meeting_id, b.starts_at, b.ends_at, b.busy_from, b.busy_to
    from busy b
    join people p on p.user_id = b.owner_id
    union
    -- taken part in
    select mp.user_id, b.id, b.starts_at, b.ends_at, b.busy_from, b.busy_to
    from busy b
    join public.meeting_participants mp on mp.organization_id = p_org and mp.meeting_id = b.id
    join people p on p.user_id = mp.user_id
  )
  select t.user_id,
         case when v.readable then mt.id end,
         case when v.readable then mt.title end,
         t.starts_at, t.ends_at, t.busy_from, t.busy_to
  from taken t
  join public.meetings mt on mt.organization_id = p_org and mt.id = t.meeting_id
  -- MUST stay in step with the meetings_select policy (migrations
  -- 20261006005320_meetings_policies.sql and
  -- 20261006009300_team_manager_internal_meetings.sql): the same expression on
  -- the row, so the id and title come back exactly when the caller could select
  -- the row.
  cross join lateral (
    select (app.can_read_record(mt.organization_id, mt.owner_id, null)
            or app.manages_meeting_organizer(mt.organization_id, mt.owner_id)
            or (app.is_member(mt.organization_id)
                and (mt.created_by = (select auth.uid()) or app.is_meeting_participant(mt.organization_id, mt.id)))
            or app.meeting_subject_ok(mt.organization_id, mt.lead_id, mt.contact_id, mt.company_id, mt.deal_id, false)) as readable
  ) v
  -- the meeting being edited is left out only when the caller may read it:
  -- excluding a hidden meeting by its id would tell who is in it
  where p_exclude is null or t.meeting_id <> p_exclude or not coalesce(v.readable, false)
  order by t.starts_at, t.ends_at, t.user_id, t.meeting_id
  limit 500;
end;
$$;

revoke all on function public.meeting_busy(uuid, uuid[], timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.meeting_busy(uuid, uuid[], timestamptz, timestamptz, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The one-time fill (a bulk update of existing meetings: only where a buffer is still null)
-- ----------------------------------------------------------------------------
-- fill:start
update public.meetings m
   set buffer_before_minutes = coalesce(m.buffer_before_minutes,
         (select ty.buffer_before_minutes from public.meeting_types ty
           where ty.organization_id = m.organization_id and ty.id = m.meeting_type_id), 0),
       buffer_after_minutes = coalesce(m.buffer_after_minutes,
         (select ty.buffer_after_minutes from public.meeting_types ty
           where ty.organization_id = m.organization_id and ty.id = m.meeting_type_id), 0)
 where m.buffer_before_minutes is null or m.buffer_after_minutes is null;
-- fill:end

alter table public.meetings alter column buffer_before_minutes set not null;
alter table public.meetings alter column buffer_after_minutes set not null;

-- ----------------------------------------------------------------------------
-- A series passes the buffers (020040's body)
-- ----------------------------------------------------------------------------
create or replace function public.create_meeting_series(
  p_org uuid,
  p_meeting jsonb,
  p_times jsonb,
  p_participants uuid[] default '{}'
) returns jsonb
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_series uuid := gen_random_uuid();
  v_ids uuid[] := '{}';
  v_id uuid;
  v_time jsonb;
  v_index integer := 0;
  v_start timestamptz;
  v_end timestamptz;
  v_prev timestamptz;
  v_user uuid;
begin
  -- invoker on purpose: RLS, column grants and the meetings triggers judge every row
  if p_org is null or p_meeting is null or jsonb_typeof(p_meeting) <> 'object'
     or p_times is null or jsonb_typeof(p_times) <> 'array'
     or jsonb_array_length(p_times) not between 2 and 52
     or cardinality(coalesce(p_participants, '{}')) > 50 then
    raise exception 'invalid meeting series' using errcode = '22023', hint = 'meeting_series:invalid';
  end if;

  for v_time in select value from jsonb_array_elements(p_times) loop
    v_index := v_index + 1;
    begin
      v_start := (v_time ->> 'starts_at')::timestamptz;
      v_end := (v_time ->> 'ends_at')::timestamptz;
    exception when others then
      raise exception 'invalid meeting series' using errcode = '22023', hint = 'meeting_series:invalid';
    end;
    if v_start is null or v_end is null or (v_prev is not null and v_start <= v_prev) then
      raise exception 'invalid meeting series' using errcode = '22023', hint = 'meeting_series:invalid';
    end if;
    v_prev := v_start;

    insert into public.meetings (
      organization_id, title, meeting_type, meeting_type_id, starts_at, ends_at, location, video_url, description,
      reminder_minutes, lead_id, contact_id, company_id, deal_id, series_id, series_index,
      buffer_before_minutes, buffer_after_minutes)
    values (
      p_org,
      p_meeting ->> 'title',
      coalesce(p_meeting ->> 'meeting_type', 'in_person'),
      (p_meeting ->> 'meeting_type_id')::uuid,
      v_start, v_end,
      p_meeting ->> 'location',
      p_meeting ->> 'video_url',
      p_meeting ->> 'description',
      (p_meeting ->> 'reminder_minutes')::integer,
      (p_meeting ->> 'lead_id')::uuid,
      (p_meeting ->> 'contact_id')::uuid,
      (p_meeting ->> 'company_id')::uuid,
      (p_meeting ->> 'deal_id')::uuid,
      v_series, v_index,
      -- CAL-10: absent = the type's (trigger meetings_buffers)
      (p_meeting ->> 'buffer_before_minutes')::integer,
      (p_meeting ->> 'buffer_after_minutes')::integer)
    returning id into v_id;
    v_ids := v_ids || v_id;
  end loop;

  -- participants after every meeting exists, so the one notice can say how many there are
  perform set_config('app.meeting_series_creating', v_series::text, true);
  foreach v_id in array v_ids loop
    foreach v_user in array coalesce(p_participants, '{}') loop
      insert into public.meeting_participants (organization_id, meeting_id, user_id)
      values (p_org, v_id, v_user)
      on conflict (meeting_id, user_id) do nothing;
    end loop;
  end loop;
  perform set_config('app.meeting_series_creating', '', true);

  return jsonb_build_object('series_id', v_series, 'ids', to_jsonb(v_ids));
end;
$$;
revoke all on function public.create_meeting_series(uuid, jsonb, jsonb, uuid[]) from public, anon;
grant execute on function public.create_meeting_series(uuid, jsonb, jsonb, uuid[]) to authenticated;

-- ----------------------------------------------------------------------------
-- One notice per series, only while the notice is new (020040's body, one more line)
-- ----------------------------------------------------------------------------
create or replace function app.notify_meeting_participant() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_notice record;
  v_series uuid;
  v_count integer;
begin
  if new.user_id is not distinct from auth.uid() then
    return null;
  end if;
  -- a suspended member is not told
  if not exists (select 1 from public.memberships m
                  where m.organization_id = new.organization_id and m.user_id = new.user_id and m.status = 'active') then
    return null;
  end if;
  -- CAL-09: one notice per series while it is unread and new
  select mt.series_id into v_series
    from public.meetings mt
   where mt.organization_id = new.organization_id and mt.id = new.meeting_id;
  if v_series is not null and exists (
    select 1 from public.notifications n
      join public.meetings m on m.organization_id = n.organization_id and m.id = n.entity_id
     where n.organization_id = new.organization_id and n.user_id = new.user_id
       and n.type = 'meeting_scheduled' and n.entity_type = 'meeting' and n.read_at is null
       -- review of CAL-09: only a notice of the last 15 minutes (the series was just made); a separate
       -- invitation to the series later is told
       and n.created_at > now() - interval '15 minutes'
       and m.series_id = v_series and m.id <> new.meeting_id) then
    return null;
  end if;
  select * into v_notice from app.meeting_notice(new.organization_id, new.meeting_id, new.user_id);
  if not coalesce(v_notice.notify, false) then
    return null;
  end if;
  if v_series is not null and current_setting('app.meeting_series_creating', true) = v_series::text then
    select count(*) into v_count from public.meetings m
     where m.organization_id = new.organization_id and m.series_id = v_series;
    v_notice.body := v_notice.body || ' · סדרה של ' || v_count || ' פגישות';
  end if;
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  values (new.organization_id, new.user_id, 'meeting_scheduled', v_notice.title, v_notice.body, 'meeting', new.meeting_id);
  return null;
end;
$$;
revoke all on function app.notify_meeting_participant() from public, anon, authenticated;

notify pgrst, 'reload schema';
