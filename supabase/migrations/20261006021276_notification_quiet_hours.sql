-- =============================================================================
-- USR-11 (first part): quiet hours for notifications
-- =============================================================================
-- Each user may choose quiet hours ("שעות שקט"), every day, the same in every business they belong to.
-- * public.notification_settings gains quiet_from / quiet_until (time; both null = off). The window may cross midnight
--   (22:00-07:00). A window whose two ends are equal is refused (constraint notification_settings_quiet).
-- * The window is read in the time zone of the business the notification belongs to (organizations.timezone).
-- * During quiet hours the bell gets the notification at once (Realtime is unchanged); only the phone push waits.
--   app.apply_notification_settings (before insert on notifications) stamps notifications.push_after = the end of the
--   window (server only: clients have no insert grant and update only read_at), and
--   public.claim_push_notifications / app.dispatch_push take a held notification only once push_after has passed,
--   within one hour of it (the same freshness rule as an ordinary push, counted from the release instead of the
--   creation). pg_cron crm-notifications runs app.dispatch_push every minute, so a held push goes out within about a
--   minute of the window's end. A held notification read in the bell meanwhile is never pushed (read_at rule, as today).
--   Kind 'system' is never held (it always arrives, as before); a muted kind is still not created; a bell-only kind is
--   still marked pushed at once, so there is nothing to hold.
-- * The end is fixed when the notification is created: changing or switching off quiet hours later moves nothing
--   already held (accepted; at most one window, under 24 hours).
-- * The business's zone is looked up in pg_timezone_names before use (once per zone and transaction, remembered in the
--   transaction-local setting app.quiet_zone_ok); a zone that is not there holds nothing, so the notification is pushed
--   as before. Nothing else in the trigger can raise, so the notification's insert never fails because of quiet hours.
-- * Clock changes: the end is the window's wall-clock end, capped so that a push is never held longer than the window's
--   own length, counted from the window's start and from the moment the notification arrived. In the autumn change a
--   window across it ends after its length (an hour before its wall-clock end); in the spring change it is an hour
--   shorter and ends at its wall-clock end. Times are 00:00..23:59 ('24:00' is refused).
-- * public.set_notification_settings gains p_quiet_set, p_quiet_from, p_quiet_until (defaults: false, null, null).
--   Without p_quiet_set the stored quiet hours are kept, so the two-argument call of the live code keeps working and
--   changes nothing it did not send. Adding arguments is a new signature: the two-argument function is first moved out
--   of the API (renamed into schema app, every grant revoked), as in 0180; one function, never two overloads.
--   Grants as before: execute to authenticated only.
-- * claim_push_notifications and dispatch_push keep their bodies of 020615 / 0010 except the freshness condition.
-- Every statement is safe to run twice.

alter table public.notification_settings
  add column if not exists quiet_from time,
  add column if not exists quiet_until time;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'notification_settings_quiet' and conrelid = 'public.notification_settings'::regclass) then
    alter table public.notification_settings
      add constraint notification_settings_quiet check (
        (quiet_from is null) = (quiet_until is null)
        and (quiet_from is null or (quiet_from <> quiet_until and quiet_from < '24:00' and quiet_until < '24:00')));
  end if;
end;
$$;

alter table public.notifications add column if not exists push_after timestamptz;
create index if not exists notifications_held_push_idx on public.notifications (push_after)
  where pushed_at is null and read_at is null and push_after is not null;

-- The end of the quiet window that holds the instant p_at, or null when p_at is outside it (or the window is off).
-- Local wall-clock time in p_zone; [from, until), crossing midnight when from > until. Capped at the window's length.
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
  v_end timestamptz;
  v_start timestamptz;
  v_length interval;
begin
  if p_from is null or p_until is null or p_from = p_until or p_at is null
     or p_from >= '24:00'::time or p_until >= '24:00'::time then
    return null;
  end if;
  v_length := p_until - p_from;
  if v_length < interval '0' then
    v_length := v_length + interval '24 hours';
  end if;
  v_local := p_at at time zone v_zone;
  v_day := v_local::date;
  v_time := v_local::time;
  if p_from < p_until then
    if v_time >= p_from and v_time < p_until then
      v_start := (v_day + p_from) at time zone v_zone;
      v_end := (v_day + p_until) at time zone v_zone;
    end if;
  elsif v_time >= p_from then
    v_start := (v_day + p_from) at time zone v_zone;
    v_end := ((v_day + 1) + p_until) at time zone v_zone;
  elsif v_time < p_until then
    v_start := ((v_day - 1) + p_from) at time zone v_zone;
    v_end := (v_day + p_until) at time zone v_zone;
  end if;
  if v_end is null then
    return null;
  end if;
  -- clock changes: never held longer than the window's own length, from its start or from p_at
  v_end := least(v_end, v_start + v_length, p_at + v_length);
  -- a clock change can put the wall-clock end at or before the instant: nothing to hold then
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
  -- USR-11: during the user's quiet hours the push waits for the window's end; the bell is not touched
  if new.pushed_at is null and new.type <> 'system' and v_from is not null and v_until is not null then
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

do $$
begin
  if to_regprocedure('public.set_notification_settings(text[], text[])') is not null then
    alter function public.set_notification_settings(text[], text[]) rename to set_notification_settings_021276_retired;
    alter function public.set_notification_settings_021276_retired(text[], text[]) set schema app;
    revoke all on function app.set_notification_settings_021276_retired(text[], text[]) from public, anon, authenticated, service_role;
  end if;
end;
$$;

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
end;
$$;
revoke all on function public.set_notification_settings(text[], text[], boolean, time, time) from public, anon;
grant execute on function public.set_notification_settings(text[], text[], boolean, time, time) to authenticated;

-- 0010's body; the freshness condition now counts a held notification from its release (USR-11)
create or replace function app.dispatch_push() returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_url text := (select s.value from app.settings s where s.key = 'push_dispatch_url');
  v_secret text := (select s.value from app.settings s where s.key = 'push_dispatch_secret');
begin
  if v_url is null or v_secret is null
     or not exists (select 1 from pg_extension where extname = 'pg_net')
     or not exists (
       select 1 from public.notifications n
        where n.pushed_at is null and n.read_at is null
          and ((n.push_after is null and n.created_at > now() - interval '1 hour')
               or (n.push_after <= now() and n.push_after > now() - interval '1 hour'))
          and exists (select 1 from public.push_subscriptions p where p.user_id = n.user_id)) then
    return false;
  end if;
  execute 'select net.http_post(url := $1, body := ''{}''::jsonb, headers := $2)'
    using v_url, jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret);
  return true;
end;
$$;
revoke all on function app.dispatch_push() from public, anon, authenticated;
grant execute on function app.dispatch_push() to service_role;

-- 020615's body; only the freshness condition changed (USR-11)
create or replace function public.claim_push_notifications(p_limit integer default 200)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  with batch as (
    select n.id
      from public.notifications n
     where n.pushed_at is null and n.read_at is null
       -- USR-11: a push held by quiet hours waits for push_after, then is fresh for an hour
       and ((n.push_after is null and n.created_at > now() - interval '1 hour')
            or (n.push_after <= now() and n.push_after > now() - interval '1 hour'))
       and exists (select 1 from public.push_subscriptions p where p.user_id = n.user_id)
       -- 0163: a closed business pushes only the system notices to its owner (stored before the closing: none)
       and (not exists (select 1 from public.organizations o2
                         where o2.id = n.organization_id and app.org_status_closed(o2.status))
            or (n.type = 'system' and exists (
                  select 1 from public.memberships m
                   where m.organization_id = n.organization_id and m.user_id = n.user_id
                     and m.status = 'active' and m.role = 'owner')))
     order by n.created_at
     limit least(greatest(coalesce(p_limit, 200), 1), 500)
     for update skip locked
  ), claimed as (
    update public.notifications n
       set pushed_at = now()
      from batch
     where n.id = batch.id
    returning n.id, n.organization_id, n.user_id, n.type, n.title, n.body, n.entity_type, n.entity_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'organization_id', c.organization_id, 'user_id', c.user_id,
           'title', c.title, 'body', c.body, 'entity_type', c.entity_type, 'entity_id', c.entity_id,
           'organization_name', o.name,
           'type', c.type,
           -- FLD-10 part three: the business's term keys, so the push says its own words (null = today's words)
           'terms', jsonb_build_object('contact_term', t.contact_term, 'lead_term', t.lead_term, 'deal_term', t.deal_term),
           'lead_actions', c.entity_type = 'lead' and c.entity_id is not null
             and c.type in ('lead_new', 'assigned')
             and exists (
               select 1 from public.leads l
                where l.organization_id = c.organization_id and l.id = c.entity_id
                  and l.deleted_at is null and l.converted_at is null
                  and (c.type = 'lead_new'
                       or (l.created_at > now() - interval '1 hour'
                           and exists (select 1 from public.form_submissions fs
                                        where fs.organization_id = c.organization_id and fs.lead_id = c.entity_id
                                          and fs.status = 'accepted'))))
         )), '[]'::jsonb)
    into v_result
    from claimed c
    join public.organizations o on o.id = c.organization_id
    left join public.org_terms t on t.organization_id = c.organization_id;
  return v_result;
end;
$$;
revoke all on function public.claim_push_notifications(integer) from public, anon, authenticated;
grant execute on function public.claim_push_notifications(integer) to service_role;
