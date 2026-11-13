-- =============================================================================
-- USR-11: the owner's answers (4), (5) and (6) on quiet hours (13 November 2026)
-- =============================================================================
-- Builds on 021276 (applied; never edited). Only what the answers change is redefined; every other line of the 021276
-- bodies is kept as it was.
-- * (6) ב, never release before the set time: app.quiet_hours_end answers the window's wall-clock end, with no cap by the
--   window's length (021276's cap is gone). Clock changes:
--   - a wall-clock end that does not exist (the spring change jumps over it) gives the first instant at or after it, that
--     is the instant the clock jumps;
--   - a wall-clock end that happens twice (the autumn change repeats an hour) gives the first time it is reached after the
--     instant, so the push goes out as soon as the clock shows the end;
--   still null when the instant is outside the window, or when the end is at or before the instant.
-- * (5) ב, urgent kinds pass at once: app.quiet_hours_exempt_kinds() is the one list of kinds never held (system, lead_new,
--   meeting_reminder); app.apply_notification_settings reads it instead of 021276's "type <> 'system'".
-- * (4) ב, a change of quiet hours takes effect at once: when public.set_notification_settings is called with
--   p_quiet_set = true, the caller's own notifications still held (pushed_at null, read_at null, push_after in the future)
--   are judged again from now() by the new setting, in each notification's business zone (the same zone check as the
--   trigger): still inside the new window = held until the new window's end; outside it, the window off, a kind on the
--   exempt list or a zone the server does not know = push_after set to now(), so the claim takes it at once and it is
--   fresh for an hour from now (setting null instead would judge it by created_at, which may be long past).
--   Only the caller's own rows change; nothing else is touched. The two-argument call (p_quiet_set false) moves nothing.
-- * Notifications of the urgent kinds held before this migration keep their stored push_after until the window ends or
--   their user saves quiet hours again; this migration rewrites no stored row.
-- Same signatures as 021276; one function per name. Every statement is safe to run twice.

create or replace function app.quiet_hours_exempt_kinds() returns text[]
language sql immutable
set search_path = ''
as $$
  select array['system', 'lead_new', 'meeting_reminder']::text[]
$$;
revoke all on function app.quiet_hours_exempt_kinds() from public, anon, authenticated;

-- The wall-clock end of the quiet window that holds the instant p_at, or null when p_at is outside it (or the window is
-- off). Local wall-clock time in p_zone; [from, until), crossing midnight when from > until. Never earlier than the
-- moment the clock in p_zone first shows the end after p_at (owner's answer (6) ב).
create or replace function app.quiet_hours_end(p_from time, p_until time, p_zone text, p_at timestamptz)
returns timestamptz
language plpgsql stable
set search_path = ''
as $$
declare
  v_zone text := coalesce(nullif(p_zone, ''), 'Asia/Jerusalem');
  v_local timestamp;
  v_day date;
  v_time time;
  v_end_local timestamp;
  v_end timestamptz;
  v_early timestamptz;
  v_lo bigint;
  v_hi bigint;
  v_mid bigint;
begin
  if p_from is null or p_until is null or p_from = p_until or p_at is null
     or p_from >= '24:00'::time or p_until >= '24:00'::time then
    return null;
  end if;
  v_local := p_at at time zone v_zone;
  v_day := v_local::date;
  v_time := v_local::time;
  if p_from < p_until then
    if v_time >= p_from and v_time < p_until then
      v_end_local := v_day + p_until;
    end if;
  elsif v_time >= p_from then
    v_end_local := (v_day + 1) + p_until;
  elsif v_time < p_until then
    v_end_local := v_day + p_until;
  end if;
  if v_end_local is null then
    return null;
  end if;
  v_end := v_end_local at time zone v_zone;
  if (v_end at time zone v_zone) = v_end_local then
    -- an end the autumn change repeats: the server picks one of its two instants; take the earlier one when it is still
    -- after p_at (the offset in force at p_at gives it)
    v_early := (v_end_local - ((p_at at time zone v_zone) - (p_at at time zone 'UTC'))) at time zone 'UTC';
    if v_early < v_end and v_early > p_at and (v_early at time zone v_zone) = v_end_local then
      v_end := v_early;
    end if;
  else
    -- an end the spring change jumps over: the first instant whose wall clock is at or after it (searched by the second
    -- within three hours on each side; one clock change at most in that span)
    v_lo := floor(extract(epoch from v_end))::bigint - 10800;
    v_hi := floor(extract(epoch from v_end))::bigint + 10800;
    if (to_timestamp(v_lo) at time zone v_zone) >= v_end_local
       or (to_timestamp(v_hi) at time zone v_zone) < v_end_local then
      return null;
    end if;
    while v_hi - v_lo > 1 loop
      v_mid := (v_lo + v_hi) / 2;
      if (to_timestamp(v_mid) at time zone v_zone) >= v_end_local then
        v_hi := v_mid;
      else
        v_lo := v_mid;
      end if;
    end loop;
    v_end := to_timestamp(v_hi);
  end if;
  -- nothing to hold when the end is at or before the instant
  if v_end is null or v_end <= p_at then
    return null;
  end if;
  return v_end;
end;
$$;
revoke all on function app.quiet_hours_end(time, time, text, timestamptz) from public, anon, authenticated;

create or replace function app.apply_notification_settings() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_muted text[];
  v_no_push text[];
  v_from time;
  v_until time;
  v_zone text;
begin
  select s.muted, s.no_push, s.quiet_from, s.quiet_until into v_muted, v_no_push, v_from, v_until
    from public.notification_settings s where s.user_id = new.user_id;
  if new.type = any (coalesce(v_muted, '{}')) then
    return null;
  end if;
  if new.type = any (coalesce(v_no_push, '{}')) then
    new.pushed_at := now();
  end if;
  -- USR-11: during the user's quiet hours the push waits for the window's end; the bell is not touched.
  -- Answer (5) ב: the urgent kinds of app.quiet_hours_exempt_kinds() are never held.
  if new.pushed_at is null and not (new.type = any (app.quiet_hours_exempt_kinds()))
     and v_from is not null and v_until is not null then
    select o.timezone into v_zone from public.organizations o where o.id = new.organization_id;
    -- a zone unknown to the server holds nothing (at time zone would raise); checked once per zone and transaction
    if v_zone is not null and current_setting('app.quiet_zone_ok', true) is distinct from v_zone then
      if exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_zone) then
        perform set_config('app.quiet_zone_ok', v_zone, true);
      else
        v_zone := null;
      end if;
    end if;
    if v_zone is not null then
      new.push_after := app.quiet_hours_end(v_from, v_until, v_zone, now());
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.apply_notification_settings() from public, anon, authenticated;

create or replace function public.set_notification_settings(
  p_muted text[],
  p_no_push text[],
  p_quiet_set boolean default false,
  p_quiet_from time default null,
  p_quiet_until time default null
) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_org record;
  v_end timestamptz;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not app.session_verified() then
    raise exception 'two-step verification required' using errcode = '42501', hint = 'mfa:aal2_required';
  end if;
  if coalesce(p_quiet_set, false)
     and ((p_quiet_from is null) <> (p_quiet_until is null) or p_quiet_from = p_quiet_until
          or p_quiet_from >= '24:00'::time or p_quiet_until >= '24:00'::time) then
    raise exception 'quiet hours need a start and an end that differ'
      using errcode = 'P0001', hint = 'notification_settings:quiet';
  end if;
  insert into public.notification_settings as s (user_id, muted, no_push, quiet_from, quiet_until, updated_at)
  values (auth.uid(), coalesce(p_muted, '{}'), coalesce(p_no_push, '{}'),
          case when coalesce(p_quiet_set, false) then p_quiet_from end,
          case when coalesce(p_quiet_set, false) then p_quiet_until end,
          now())
  on conflict (user_id) do update
    set muted = excluded.muted,
        no_push = excluded.no_push,
        quiet_from = case when coalesce(p_quiet_set, false) then excluded.quiet_from else s.quiet_from end,
        quiet_until = case when coalesce(p_quiet_set, false) then excluded.quiet_until else s.quiet_until end,
        updated_at = now();
  -- USR-11 answer (4) ב: the caller's pushes still held are judged again at once by the new setting, from now(), in each
  -- notification's business zone; released = push_after now() (fresh for an hour from now)
  if coalesce(p_quiet_set, false) then
    for v_org in
      select n.organization_id, o.timezone
        from public.notifications n
        left join public.organizations o on o.id = n.organization_id
       where n.user_id = auth.uid() and n.pushed_at is null and n.read_at is null and n.push_after > now()
       group by n.organization_id, o.timezone
    loop
      v_end := null;
      if v_org.timezone is not null and p_quiet_from is not null and p_quiet_until is not null
         and exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_org.timezone) then
        v_end := app.quiet_hours_end(p_quiet_from, p_quiet_until, v_org.timezone, now());
      end if;
      update public.notifications n
         set push_after = case when n.type = any (app.quiet_hours_exempt_kinds()) then now()
                               else coalesce(v_end, now()) end
       where n.user_id = auth.uid() and n.organization_id = v_org.organization_id
         and n.pushed_at is null and n.read_at is null and n.push_after > now();
    end loop;
  end if;
end;
$$;
revoke all on function public.set_notification_settings(text[], text[], boolean, time, time) from public, anon;
grant execute on function public.set_notification_settings(text[], text[], boolean, time, time) to authenticated;
