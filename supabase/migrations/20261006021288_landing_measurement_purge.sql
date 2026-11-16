-- =============================================================================
-- LND-14: the removal of landing-page counters older than 25 months (app.landing_event_days)
-- =============================================================================
-- Its own small file because it holds a statement the connector refuses: the owner pastes it in the SQL Editor after
-- _landing_measurement.sql, whose wrapper app.run_landing_event_purge() (pg_cron 'crm-landing-measurement-purge', nightly at
-- 02:43 UTC) calls this function once it exists. The rows hold a day, an event kind, a source and a count, nothing about a
-- visitor. At most p_limit rows a run, oldest day first; rows another call holds are skipped. Safe to run twice.

create or replace function app.landing_event_purge_rows(p_limit integer) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  with old as (
    select d.day, d.kind, d.source from app.landing_event_days d
     where d.day < ((now() at time zone 'Asia/Jerusalem')::date - interval '25 months')::date
     order by d.day
     limit greatest(coalesce(p_limit, 0), 0)
     for update skip locked)
  delete from app.landing_event_days d using old
   where d.day = old.day and d.kind = old.kind and d.source = old.source;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function app.landing_event_purge_rows(integer) from public, anon, authenticated, service_role;
