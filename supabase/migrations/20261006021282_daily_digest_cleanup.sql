-- =============================================================================
-- USR-11 / WAB-03: the daily summary's cleanup (to be pasted by hand in the SQL Editor: it deletes)
-- =============================================================================
-- Called nightly by app.run_digest_cleanup() (021281, pg_cron crm-digest-cleanup). Removes the stop tokens that expired a day
-- ago or more (a token lives 30 days) and the once-a-day bookkeeping rows older than 60 days. Nothing else. Safe to run twice.
create or replace function app.digest_cleanup_rows() returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  delete from app.digest_stop_tokens t where t.expires_at < now() - interval '1 day';
  delete from app.digest_sends s where s.day < (now() at time zone 'UTC')::date - 60;
end;
$$;
revoke all on function app.digest_cleanup_rows() from public, anon, authenticated, service_role;
