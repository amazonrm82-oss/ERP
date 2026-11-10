-- =============================================================================
-- INT-03: connection log lines are removed after 12 months (owner, 10 November 2026, answer (228) ב)
-- =============================================================================
-- PASTED BY HAND in the SQL Editor (the connector stops on a migration that holds a delete statement). Belongs to
-- _integration_events.sql, which makes public.integration_events and the nightly job crm-integration-events-purge; that job
-- calls app.purge_old_integration_events(), which does nothing until this function exists. Safe to run twice.
--
-- app.integration_events_purge_rows(limit): removes a live connection's log lines whose last_at is more than 12 months ago,
-- and a deleted connection's lines 12 months after the deletion (`connection_deleted_at`, stamped by the delete), at most
-- `limit` a run (0..10,000), oldest first, and the failure-notice days older than 30 days; answers how many log lines it
-- removed.
-- Security definer, search_path pinned, no client may call it.

create or replace function app.integration_events_purge_rows(p_limit integer) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.integration_events e
   where e.id in (select o.id from public.integration_events o
                   where (o.connection_deleted_at is null and o.last_at < now() - interval '12 months')
                      or o.connection_deleted_at < now() - interval '12 months'
                   order by coalesce(o.connection_deleted_at, o.last_at)
                   limit least(greatest(coalesce(p_limit, 0), 0), 10000));
  get diagnostics v_count = row_count;
  delete from app.integration_notice_days d where d.day < current_date - 30;
  return v_count;
end;
$$;
revoke all on function app.integration_events_purge_rows(integer) from public, anon, authenticated, service_role;
