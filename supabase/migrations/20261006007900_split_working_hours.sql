-- =============================================================================
-- Split working hours (USR-01, owner's decision of 12 October 2026)
-- =============================================================================
-- A working day may have more than one range (08:00-12:00 and 16:00-19:00).
-- New shape of profiles.working_hours:
--   {"sun": [{"start": "08:00", "end": "12:00"}, {"start": "16:00", "end": "19:00"}], ...}
-- Each day is a list of 1 to 3 ranges, sorted, not overlapping (the end of one
-- is at most the start of the next), times HH:MM in 24 hours, start before end.
-- The first shape (one {"start", "end"} object per day, migration
-- profile_fields) stays valid: rows of it already exist and are not rewritten
-- here. The app reads both and writes the new one when the user saves.
-- Only app.working_hours_ok() changes (create or replace); the constraint
-- profiles_working_hours_check keeps calling it. Mirrored by
-- src/features/profile/working-hours.ts. Safe to run twice.

create or replace function app.working_hours_ok(p_hours jsonb) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v_day text;
  v_value jsonb;
  v_range jsonb;
  v_prev_end text;
  v_time constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
begin
  if p_hours is null then
    return true;
  end if;
  if jsonb_typeof(p_hours) <> 'object' then
    return false;
  end if;
  for v_day, v_value in select e.key, e.value from jsonb_each(p_hours) e loop
    if v_day not in ('sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat') then
      return false;
    end if;
    if jsonb_typeof(v_value) = 'array' then
      if jsonb_array_length(v_value) < 1 or jsonb_array_length(v_value) > 3 then
        return false;
      end if;
    elsif jsonb_typeof(v_value) <> 'object' then
      return false;
    end if;
    v_prev_end := null;
    -- the first shape is one range; the new one a list of them, in order
    for v_range in
      select r.value from jsonb_array_elements(case when jsonb_typeof(v_value) = 'array' then v_value else jsonb_build_array(v_value) end)
        with ordinality as r(value, n)
       order by r.n
    loop
      if jsonb_typeof(v_range) <> 'object'
         or (select count(*) from jsonb_object_keys(v_range)) <> 2
         or jsonb_typeof(v_range -> 'start') is distinct from 'string'
         or jsonb_typeof(v_range -> 'end') is distinct from 'string' then
        return false;
      end if;
      if (v_range ->> 'start') !~ v_time or (v_range ->> 'end') !~ v_time then
        return false;
      end if;
      if (v_range ->> 'start') collate "C" >= (v_range ->> 'end') collate "C" then
        return false;
      end if;
      if v_prev_end is not null and v_prev_end collate "C" > (v_range ->> 'start') collate "C" then
        return false;
      end if;
      v_prev_end := v_range ->> 'end';
    end loop;
  end loop;
  return true;
end;
$$;
revoke all on function app.working_hours_ok(jsonb) from public, anon;
grant execute on function app.working_hours_ok(jsonb) to authenticated, service_role;
