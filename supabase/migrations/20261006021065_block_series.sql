-- =============================================================================
-- 021065 Recurring blocked time (GAP-07, the rest; owner 18 October 2026)
-- =============================================================================
-- Owner: "חסימה אישית חוזרת באותו מנגנון של סדרת פגישות; משפיעה על דף קביעת התור ועל אזהרות ההתנגשות".
-- (Reading an external ICS link waits for the Google sync of wave 4: not here.)
--
-- * A weekly block series is a CAL-09 meeting series whose rows are blocks: public.create_meeting_series makes all of
--   them in one transaction (all or nothing), meetings_series_check keeps the series honest exactly as for meetings, and
--   "this and following" is done by the app with the user's session, row by row, as for meetings.
-- * Constraint meetings_block_shape: a block may now carry series_id (meetings_series_shape still pairs it with an index
--   1..52). Every other block rule stays: no lead, contact, company or deal, no business meeting type, no reminder, no
--   buffers, only planned or cancelled.
-- * public.create_meeting_series (020065's body) reads two more optional keys of p_meeting:
--   - is_block (absent = false): the rows are blocks; the block shape is judged by the constraint on every row.
--   - owner_id (absent = the writer, as before, by app.default_owner): so moving "this and following" of someone else's
--     block series to another weekday keeps it theirs. meetings_check_owner judges it exactly as a direct insert
--     (only the person themself or an admin may name an organizer); the function is security invoker.
--   A series of blocks takes no participants (22023, hint meeting_series:block_participants). Nothing changes for a
--   caller that sends neither key.
-- Each occurrence is an ordinary block row, so the booking page (app.booking_slots), public.meeting_busy, the conflict
-- warnings and the calendar feed see each one as busy with no change there.
-- No delete, no drop statement. Safe to run twice.

alter table public.meetings
  drop constraint if exists meetings_block_shape,
  add constraint meetings_block_shape check (
    not is_block
    or (lead_id is null and contact_id is null and company_id is null and deal_id is null
        and meeting_type_id is null and reminder_minutes is null
        and buffer_before_minutes = 0 and buffer_after_minutes = 0
        and status in ('planned', 'cancelled')));

-- unchanged since 020115 (a block is made with is_block, never changed into or out of one); stated again so a test that
-- re-runs 020115, which also sets the constraint above, re-runs this file after it
grant insert (is_block) on public.meetings to authenticated;

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
  v_block boolean;
  v_owner uuid;
begin
  -- invoker on purpose: RLS, column grants and the meetings triggers judge every row
  if p_org is null or p_meeting is null or jsonb_typeof(p_meeting) <> 'object'
     or p_times is null or jsonb_typeof(p_times) <> 'array'
     or jsonb_array_length(p_times) not between 2 and 52
     or cardinality(coalesce(p_participants, '{}')) > 50 then
    raise exception 'invalid meeting series' using errcode = '22023', hint = 'meeting_series:invalid';
  end if;
  -- GAP-07: a series of blocks, and an organizer named by the caller (both optional)
  begin
    v_block := coalesce((p_meeting ->> 'is_block')::boolean, false);
    v_owner := (p_meeting ->> 'owner_id')::uuid;
  exception when others then
    raise exception 'invalid meeting series' using errcode = '22023', hint = 'meeting_series:invalid';
  end;
  -- a block is one person's own time: nobody takes part in it
  if v_block and cardinality(coalesce(p_participants, '{}')) > 0 then
    raise exception 'a block has no participants' using errcode = '22023', hint = 'meeting_series:block_participants';
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
      buffer_before_minutes, buffer_after_minutes, is_block, owner_id)
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
      (p_meeting ->> 'buffer_after_minutes')::integer,
      v_block,
      -- null = the writer (app.default_owner); a named one is judged by meetings_check_owner
      v_owner)
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

notify pgrst, 'reload schema';
