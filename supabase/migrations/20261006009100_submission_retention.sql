-- =============================================================================
-- Inquiries of a deleted form are kept 12 months (CAP-04)
-- =============================================================================
-- Owner's decision of 12 October 2026: the submissions (inquiries) of a deleted
-- form are kept for 12 months from the day the form was deleted, then removed
-- automatically. The leads created from them stay. There is no new screen: the
-- last 30 on the intake settings page and the full export stay as they are.
--
-- This migration (applied through the connector):
-- * form_submissions.form_deleted_at (timestamptz, null while the form exists):
--   when the row's form was deleted. Server-only: clients have no write grant
--   on form_submissions at all (0007), and admins read it like the other
--   columns (form_submissions_select is unchanged).
-- * app.keep_form_submissions() (trigger forms_keep_submissions, 0062) now also
--   stamps form_deleted_at = now() on the deleted form's rows, next to the
--   form's name. Unchanged otherwise: a name already kept is not overwritten,
--   and nothing is written when the whole organization is going.
-- * Rows already kept before this migration (form_id null) have no deletion
--   date; their clock starts now: one update stamps form_deleted_at = now() on
--   rows where form_id is null and form_deleted_at is null. It only fills the
--   new column (no row is removed, no existing value is rewritten), and the
--   second run finds nothing to stamp.
-- * pg_cron job 'crm-purge-submissions' at 02:45 UTC (between crm-purge-trash
--   02:30 and crm-file-cleanup 03:00) calls app.purge_old_form_submissions().
--   That function is in its own file, 20261006009110_submission_retention_purge.sql,
--   which the owner runs by hand in the SQL Editor (the connector stops on
--   statements that remove rows). pg_cron stores the command as text and does
--   not check it when scheduling, so the job may exist before the function:
--   until the function is there, the nightly run fails with "function does not
--   exist" in cron.job_run_details and changes nothing.
-- Removing a submission changes nothing else: no table references
-- form_submissions, its lead link points from the submission to the lead (when
-- a lead goes, only the submission's lead_id is emptied), and form_submissions
-- has no audit, event or removal trigger. Privacy erasure and lead purge (app.erase_submissions,
-- app.purge_links) keep working on the rows that remain.
-- Every statement is safe to run twice.

alter table public.form_submissions add column if not exists form_deleted_at timestamptz;

-- the nightly job looks only at kept rows, oldest first
create index if not exists form_submissions_form_deleted_idx on public.form_submissions (form_deleted_at)
  where form_deleted_at is not null;

create or replace function app.keep_form_submissions() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- the whole organization is going (cascade): its submissions go with it, and
  -- by now its leads may be gone, so an update here would fail the lead FK check
  if not exists (select 1 from public.organizations o where o.id = old.organization_id) then
    return old;
  end if;
  update public.form_submissions s
     set form_name = coalesce(s.form_name, old.name),
         form_deleted_at = coalesce(s.form_deleted_at, now())
   where s.organization_id = old.organization_id
     and s.form_id = old.id;
  return old;
end;
$$;
revoke all on function app.keep_form_submissions() from public, anon, authenticated;

-- rows kept before this migration: their 12 months start now
update public.form_submissions
   set form_deleted_at = now()
 where form_id is null
   and form_deleted_at is null;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-purge-submissions', '45 2 * * *', 'select app.purge_old_form_submissions();');
  end if;
end;
$$;
