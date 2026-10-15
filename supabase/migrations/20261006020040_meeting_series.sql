-- =============================================================================
-- 0199 Recurring meetings (CAL-09): a weekly series of N meetings
-- =============================================================================
-- "פגישה חוזרת, למשל סדרת טיפולים: שבועית, X פעמים". A series is made up front as
-- real meetings, so reminders (CAL-06), conflicts (CAL-05), the calendar feed and the
-- invite file (CAL-07), meeting types (CAL-08), rights (CAL-01) and the calendar all
-- keep working unchanged, one meeting at a time.
-- * meetings.series_id: the series a meeting belongs to (a plain grouping id, no table;
--   null = a single meeting). meetings.series_index: its place in the series, 1..52.
--   Both are set once, on insert, and never change (insert grant only).
-- * Trigger meetings_series_check (every writer) keeps a series honest: index 1 opens a
--   series id this organization has not used yet (only this organization is looked at, so
--   the check tells nothing about other businesses; two inserts at the same moment meet the
--   unique index); any later index needs the series' first meeting in the same organization,
--   created by the same person, and the index just before it. So nobody can add a meeting
--   into someone else's series.
-- * One notice per series (review, 15 October 2026): app.notify_meeting_participant (from
--   0068) now sends nothing for a series meeting while the person still has an unread
--   "meeting_scheduled" notice about another meeting of the same series. While
--   create_meeting_series runs, it adds all the meetings first and then the participants,
--   so each participant gets one notice, about the first meeting, with "סדרה של N פגישות"
--   (the transaction-local setting app.meeting_series_creating names the series; nothing a
--   client can reach sets it). A single meeting, or a later change, notifies as before.
-- * public.create_meeting_series(org, meeting, times, participants): security invoker, so
--   RLS, the column grants and every meetings trigger apply to each meeting exactly as
--   to one made by hand. It makes all the meetings of the series and their participants
--   in one transaction (all or nothing), with a new series id. The times come from the
--   app (src/features/meetings/series.ts: same wall-clock time every week in the
--   organization's zone); here they are checked: 2..52, each a valid meeting, every one
--   later than the one before (hint 'meeting_series:invalid').
-- * Editing "this one" is the ordinary meeting edit. "This and following" is done by the
--   app with the user's session (RLS decides row by row).
-- No plan key (core, like the calendar). No delete, no drop. Safe to run twice.

alter table public.meetings add column if not exists series_id uuid;
alter table public.meetings add column if not exists series_index integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.meetings'::regclass and conname = 'meetings_series_shape') then
    alter table public.meetings add constraint meetings_series_shape check (
      (series_id is null and series_index is null)
      or (series_id is not null and series_index between 1 and 52));
  end if;
end;
$$;

create unique index if not exists meetings_series_idx on public.meetings (organization_id, series_id, series_index)
  where series_id is not null;

grant insert (series_id, series_index) on public.meetings to authenticated;

comment on column public.meetings.series_id is 'CAL-09: the weekly series the meeting belongs to; set on insert only.';
comment on column public.meetings.series_index is 'CAL-09: the meeting''s place in its series, 1..52.';

create or replace function app.meetings_series_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_head_org uuid;
  v_head_by uuid;
begin
  -- definer: it must see every meeting of the id, whoever may read them; it answers only
  -- yes or no and is about the row being inserted
  if new.series_id is null then
    return new;
  end if;
  if new.series_index = 1 then
    -- this organization only (no cross-business answer); a race meets meetings_series_idx
    if exists (select 1 from public.meetings m where m.organization_id = new.organization_id and m.series_id = new.series_id) then
      raise exception 'invalid meeting series' using errcode = 'P0001', hint = 'meeting_series:invalid';
    end if;
    return new;
  end if;
  select m.organization_id, m.created_by into v_head_org, v_head_by
    from public.meetings m
   where m.organization_id = new.organization_id and m.series_id = new.series_id and m.series_index = 1;
  if v_head_org is distinct from new.organization_id
     or v_head_by is distinct from coalesce(auth.uid(), new.created_by)
     or not exists (select 1 from public.meetings m
                     where m.organization_id = new.organization_id
                       and m.series_id = new.series_id
                       and m.series_index = new.series_index - 1) then
    raise exception 'invalid meeting series' using errcode = 'P0001', hint = 'meeting_series:invalid';
  end if;
  return new;
end;
$$;
revoke all on function app.meetings_series_check() from public, anon, authenticated;

create or replace trigger meetings_series_check before insert on public.meetings
  for each row execute function app.meetings_series_check();

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
      reminder_minutes, lead_id, contact_id, company_id, deal_id, series_id, series_index)
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
      v_series, v_index)
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
-- One notice per series (0068's body, plus the series lines)
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
  -- CAL-09: one notice per series while it is unread
  select mt.series_id into v_series
    from public.meetings mt
   where mt.organization_id = new.organization_id and mt.id = new.meeting_id;
  if v_series is not null and exists (
    select 1 from public.notifications n
      join public.meetings m on m.organization_id = n.organization_id and m.id = n.entity_id
     where n.organization_id = new.organization_id and n.user_id = new.user_id
       and n.type = 'meeting_scheduled' and n.entity_type = 'meeting' and n.read_at is null
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
