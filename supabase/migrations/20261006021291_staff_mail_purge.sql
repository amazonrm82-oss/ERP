-- =============================================================================
-- RPT-03 / USR-09 retention (delta review 3): the deletes of the two staff-mail send logs. PASTED BY HAND by the owner (the
-- connector stops on a delete); app.run_staff_mail_purge (migration 021290, pg_cron `crm-staff-mail-purge`, 02:47 UTC) calls
-- it once it exists.
-- =============================================================================
-- * app.invitation_email_sends: rows requested more than 30 days ago.
-- * app.report_schedule_sends: rows queued more than 90 days ago.
-- Every cap reads at most one business day back (per address, per business) or 24 hours (per requesting person, per address
-- across businesses), and "once per schedule, recipient and day" reads only the day itself, so removing rows this old never
-- lowers a count that is still read. At most p_limit rows of each table per call, oldest first, skip locked.
-- Safe to run twice.
create or replace function app.staff_mail_purge_rows(p_limit integer default 5000) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 5000), 1), 50000);
  v_invites integer;
  v_reports integer;
begin
  with doomed as (
    select s.id from app.invitation_email_sends s
     where s.requested_at < now() - interval '30 days'
     order by s.requested_at
     limit v_limit
     for update skip locked
  )
  delete from app.invitation_email_sends s using doomed d where s.id = d.id;
  get diagnostics v_invites = row_count;

  with doomed as (
    select s.schedule_id, s.user_id, s.day from app.report_schedule_sends s
     where s.queued_at < now() - interval '90 days'
     order by s.queued_at
     limit v_limit
     for update skip locked
  )
  delete from app.report_schedule_sends s using doomed d
   where s.schedule_id = d.schedule_id and s.user_id = d.user_id and s.day = d.day;
  get diagnostics v_reports = row_count;
  return v_invites + v_reports;
end;
$$;
revoke all on function app.staff_mail_purge_rows(integer) from public, anon, authenticated, service_role;
