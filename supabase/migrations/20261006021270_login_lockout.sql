-- =============================================================================
-- USR-13 (lockout part): lock a sign-in address after 5 failed attempts, and log failed sign-ins
-- =============================================================================
-- Owner, 13 November 2026, answers (364) א and (370) א:
-- * After 5 failed sign-ins for the same address, that address is locked for 15 minutes; the attempts are logged (the
--   counters below are the log, plus one app.platform_log line per lock, with the kind only).
-- * The sign-in form answers EXACTLY the same message for "locked" and "wrong password", so it never tells whether an address
--   has an account: an address with no account is counted and locked the same way.
-- * CLAUDE.md hard rule 5's pattern: ONE security definer function, public.login_guard(), granted to service_role only, called
--   only by src/features/auth/login-guard-server.ts (inside the sign-in action); no direct table access for any API role.
-- * It counts only by the sender's IP and by the address, and never sees either: the server sends the keyed hash of the IP
--   (src/lib/keyed-ip-hash.ts, scope `login`, an IPv6 sender by its /64) and the keyed hash of the address (trimmed, lower
--   case; same secret, scope `login-email`). No password, no request body, no plain address is stored.
-- * Besides the address: one sender (IP hash) with 50 failed sign-ins across any addresses within 15 minutes is locked for 15
--   minutes too (lead's choice; a shared office or mobile carrier address may be locked by someone else's failures, accepted).
-- * Reserve before Auth (review of 13 November 2026): the event 'attempt' takes one try of the address and of the sender under
--   their row locks BEFORE the sign-in is sent to Auth, and refuses when either is locked; so a burst of parallel tries gets at
--   most 5 through for an address. The try that reaches the threshold sets the lock (15 minutes from that try).
--   After Auth: 'success' clears the address's count (and the pending lock its own reserved tries made, which only an admitted
--   try can reach) and gives the sender's try back, so many correct sign-ins from one office never lock it (delta review);
--   'release' gives back the reserved try of both when Auth failed for another reason (network, 5xx, rate limit, unconfirmed
--   address), and lifts a lock that try had set. Both change a row only while it is still in the window the try was counted
--   in. A wrong password needs no call: its try is already counted.
-- * Storage: app.login_attempts, one row per kind and FULL keyed hash (no shared slots, so one address can never hide
--   another's count). Stale rows (window and lock over) are removed by app.login_attempts_purge_rows(limit), which lives in
--   the next migration file (pasted by hand: the connector refuses that statement); pg_cron crm-login-attempts-purge calls
--   app.run_login_attempts_purge(), which does nothing until that function exists. Until then rows simply stay (hashes and
--   counts only).
-- Safe to run twice.

create table if not exists app.login_attempts (
  kind           text not null check (kind in ('email', 'ip')),
  key_hash       text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  failures       integer not null default 0 check (failures >= 0),
  window_start   timestamptz,
  locked_until   timestamptz,
  lock_logged_at timestamptz,
  primary key (kind, key_hash)
);
create index if not exists login_attempts_stale_idx on app.login_attempts (window_start);
alter table app.login_attempts enable row level security;
revoke all on table app.login_attempts from public, anon, authenticated, service_role;

-- the rules in one place (tests read them): tries that lock, the counting window and the lock, per kind
create or replace function app.login_lock_threshold(p_kind text) returns integer
language sql immutable
set search_path = ''
as $$
  select case p_kind when 'email' then 5 when 'ip' then 50 end
$$;
revoke all on function app.login_lock_threshold(text) from public, anon, authenticated, service_role;

create or replace function app.login_window() returns interval
language sql immutable
set search_path = ''
as $$
  select interval '15 minutes'
$$;
revoke all on function app.login_window() from public, anon, authenticated, service_role;

create or replace function app.login_lock_length() returns interval
language sql immutable
set search_path = ''
as $$
  select interval '15 minutes'
$$;
revoke all on function app.login_lock_length() from public, anon, authenticated, service_role;

-- the row of one hash, made when missing and taken FOR UPDATE; a window that ended (and no live lock) starts again.
-- The window is FIXED: it starts at the first try and does not slide with later tries (accepted by design).
create or replace function app.login_row(p_kind text, p_hash text) returns app.login_attempts
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_row app.login_attempts;
begin
  -- the stale-row purge may remove the row between the insert and the lock: insert again until it is held
  loop
    insert into app.login_attempts (kind, key_hash) values (p_kind, p_hash) on conflict (kind, key_hash) do nothing;
    select * into v_row from app.login_attempts a where a.kind = p_kind and a.key_hash = p_hash for update;
    exit when found;
  end loop;
  if coalesce(v_row.locked_until > now(), false) is false
     and coalesce(v_row.window_start > now() - app.login_window(), false) is false then
    v_row.failures := 0;
    v_row.window_start := null;
    v_row.locked_until := null;
    v_row.lock_logged_at := null;
  end if;
  return v_row;
end;
$$;
revoke all on function app.login_row(text, text) from public, anon, authenticated, service_role;

-- writes back a row read by app.login_row
create or replace function app.login_row_save(p_row app.login_attempts) returns void
language sql volatile security definer
set search_path = ''
as $$
  update app.login_attempts a
     set failures = p_row.failures, window_start = p_row.window_start, locked_until = p_row.locked_until,
         lock_logged_at = p_row.lock_logged_at
   where a.kind = p_row.kind and a.key_hash = p_row.key_hash
$$;
revoke all on function app.login_row_save(app.login_attempts) from public, anon, authenticated, service_role;

-- one try taken: counted, and locked when it reaches the threshold
create or replace function app.login_count(p_row app.login_attempts) returns app.login_attempts
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_row app.login_attempts := p_row;
begin
  v_row.failures := v_row.failures + 1;
  v_row.window_start := coalesce(v_row.window_start, now());
  if v_row.failures >= app.login_lock_threshold(v_row.kind) then
    v_row.locked_until := now() + app.login_lock_length();
  end if;
  return v_row;
end;
$$;
revoke all on function app.login_count(app.login_attempts) from public, anon, authenticated, service_role;

-- a refusal of a locked row: the lock is logged once (kind only, never the hash). Only lock_logged_at is written, and only
-- while the stored row is still locked: the row may come from a read without a row lock (the sender pre-check), so the
-- counts and the lock are never written back from it (a success committed meanwhile is kept)
create or replace function app.login_refused(p_row app.login_attempts) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  update app.login_attempts a
     set lock_logged_at = now()
   where a.kind = p_row.kind and a.key_hash = p_row.key_hash
     and a.lock_logged_at is null and a.locked_until > now();
  if found then
    perform app.log_platform('login.locked', null, jsonb_build_object('kind', p_row.kind));
  end if;
end;
$$;
revoke all on function app.login_refused(app.login_attempts) from public, anon, authenticated, service_role;

-- gives back one try reserved in window p_window (only while the row is still in that window); a lock that try had set is lifted
create or replace function app.login_give_back(p_row app.login_attempts, p_window timestamptz) returns app.login_attempts
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_row app.login_attempts := p_row;
begin
  if p_window is null or v_row.window_start is distinct from p_window or v_row.failures <= 0 then
    return v_row;
  end if;
  v_row.failures := v_row.failures - 1;
  if v_row.failures < app.login_lock_threshold(v_row.kind) then
    v_row.locked_until := null;
    v_row.lock_logged_at := null;
  end if;
  return v_row;
end;
$$;
revoke all on function app.login_give_back(app.login_attempts, timestamptz) from public, anon, authenticated, service_role;

-- The one entry point (service_role only). p_event:
--   'attempt' before the sign-in: refuses ({locked: true}, nothing counted) when the sender or the address is locked, else
--             counts one try of each under their row locks (a lock starts with the try that reaches the threshold) and
--             answers {locked: false, email_window, ip_window}: the window each try was counted in;
--   'success' after a sign-in: clears the address's count and gives the sender's try back (lifting a lock that try set);
--   'release' after an Auth failure that is not a wrong address or password: gives back the reserved try of each.
-- 'success' and 'release' pass back the windows 'attempt' answered (p_email_window, p_ip_window, not secret) and change a row
-- only while it is still in that window, so a late answer never takes a try off a newer window.
-- A hash that is not 64 lower-case hex is ignored (null = not counted); with neither hash nothing is read or written.
-- Lock order: the address row, then the sender row, on every path. A locked sender is first read WITHOUT a row lock, so a
-- refused try from a locked sender creates no address row; under the row locks the sender is judged again.
create or replace function public.login_guard(
  p_email_hash text, p_ip_hash text, p_event text, p_email_window timestamptz default null, p_ip_window timestamptz default null
) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_email_hash text := case when p_email_hash ~ '^[0-9a-f]{64}$' then p_email_hash end;
  v_ip_hash    text := case when p_ip_hash ~ '^[0-9a-f]{64}$' then p_ip_hash end;
  v_email      app.login_attempts;
  v_ip         app.login_attempts;
  v_locked     boolean := false;
begin
  if p_event is null or p_event not in ('attempt', 'success', 'release') then
    raise exception 'unknown login event' using errcode = '22023', hint = 'login:event';
  end if;
  if v_email_hash is null and v_ip_hash is null then
    return jsonb_build_object('locked', false);
  end if;

  if p_event in ('success', 'release') then
    -- rows that are gone have nothing to give back; never made here
    if v_email_hash is not null then
      select * into v_email from app.login_attempts a where a.kind = 'email' and a.key_hash = v_email_hash for update;
      if found and p_email_window is not null and v_email.window_start is not distinct from p_email_window then
        if p_event = 'success' then
          v_email.failures := 0;
          v_email.window_start := null;
          v_email.locked_until := null;
          v_email.lock_logged_at := null;
        else
          v_email := app.login_give_back(v_email, p_email_window);
        end if;
        perform app.login_row_save(v_email);
      end if;
    end if;
    if v_ip_hash is not null then
      select * into v_ip from app.login_attempts a where a.kind = 'ip' and a.key_hash = v_ip_hash for update;
      if found then
        perform app.login_row_save(app.login_give_back(v_ip, p_ip_window));
      end if;
    end if;
    return jsonb_build_object('locked', false);
  end if;

  -- attempt: a locked sender is refused before any address row is made or locked (a plain read, no row lock)
  if v_ip_hash is not null then
    select * into v_ip from app.login_attempts a where a.kind = 'ip' and a.key_hash = v_ip_hash;
    if found and coalesce(v_ip.locked_until > now(), false) then
      perform app.login_refused(v_ip);
      return jsonb_build_object('locked', true);
    end if;
  end if;

  -- rows taken in the same order (email, then ip), so two concurrent calls cannot deadlock
  if v_email_hash is not null then
    v_email := app.login_row('email', v_email_hash);
  end if;
  if v_ip_hash is not null then
    v_ip := app.login_row('ip', v_ip_hash);
  end if;

  -- refused while either is locked (nothing counted), else one try of each taken
  if v_email_hash is not null and coalesce(v_email.locked_until > now(), false) then
    perform app.login_refused(v_email);
    v_locked := true;
  end if;
  if v_ip_hash is not null and coalesce(v_ip.locked_until > now(), false) then
    perform app.login_refused(v_ip);
    v_locked := true;
  end if;
  if v_locked then
    return jsonb_build_object('locked', true);
  end if;
  if v_email_hash is not null then
    v_email := app.login_count(v_email);
    perform app.login_row_save(v_email);
  end if;
  if v_ip_hash is not null then
    v_ip := app.login_count(v_ip);
    perform app.login_row_save(v_ip);
  end if;
  return jsonb_build_object('locked', false, 'email_window', v_email.window_start, 'ip_window', v_ip.window_start);
end;
$$;
revoke all on function public.login_guard(text, text, text, timestamptz, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.login_guard(text, text, text, timestamptz, timestamptz) to service_role;

-- the job: removes stale rows through the hand-pasted app.login_attempts_purge_rows(limit), a no-op until it exists
create or replace function app.run_login_attempts_purge() returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_n integer := 0;
begin
  if to_regprocedure('app.login_attempts_purge_rows(integer)') is null then
    return 0;
  end if;
  execute 'select app.login_attempts_purge_rows($1)' into v_n using 20000;
  return coalesce(v_n, 0);
end;
$$;
revoke all on function app.run_login_attempts_purge() from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-login-attempts-purge', '*/5 * * * *', 'select app.run_login_attempts_purge();');
  end if;
end;
$$;
