-- =============================================================================
-- Inquiries of a deleted form are kept 12 months: the nightly removal (CAP-04)
-- =============================================================================
-- Runs by hand in the SQL Editor (the connector stops on a migration that holds
-- a delete statement). Belongs to 20261006009100_submission_retention.sql, which
-- adds form_submissions.form_deleted_at and schedules pg_cron job
-- 'crm-purge-submissions' (02:45 UTC) to call this function.
--
-- app.purge_old_form_submissions(): removes the submissions whose form was
-- deleted more than 12 months ago (form_id null and form_deleted_at older than
-- now() - 12 months) and returns how many. Their leads stay: the link is
-- form_submissions -> leads, and nothing references form_submissions.
-- Security definer (it runs from pg_cron), search_path pinned, no client may
-- call it. Safe to run twice.

create or replace function app.purge_old_form_submissions() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.form_submissions s
   where s.form_id is null
     and s.form_deleted_at is not null
     and s.form_deleted_at < now() - interval '12 months';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function app.purge_old_form_submissions() from public, anon, authenticated;
