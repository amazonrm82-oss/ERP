-- =============================================================================
-- USR-13: the removal of stale sign-in counters (app.login_attempts)
-- =============================================================================
-- Its own small file because it holds a statement the connector refuses: the owner pastes it in the SQL Editor after
-- _login_lockout.sql, whose wrapper app.run_login_attempts_purge() (pg_cron 'crm-login-attempts-purge', every 5 minutes)
-- calls this function once it exists. A row is stale when its counting window and its lock are both over; it holds only a
-- keyed hash and counts. At most p_limit rows a run, oldest window first; rows another call holds are skipped.
-- Safe to run twice.

create or replace function app.login_attempts_purge_rows(p_limit integer) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  with stale as (
    select a.kind, a.key_hash from app.login_attempts a
     where (a.locked_until is null or a.locked_until <= now())
       and (a.window_start is null or a.window_start <= now() - app.login_window())
     order by a.window_start nulls first
     limit greatest(coalesce(p_limit, 0), 0)
     for update skip locked)
  delete from app.login_attempts a using stale where a.kind = stale.kind and a.key_hash = stale.key_hash;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function app.login_attempts_purge_rows(integer) from public, anon, authenticated, service_role;
