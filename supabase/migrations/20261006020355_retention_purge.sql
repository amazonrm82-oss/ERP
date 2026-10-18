-- =============================================================================
-- Nightly removal in batches: old notifications, and the recycle bin (FXD-06)
-- =============================================================================
-- Runs by hand in the SQL Editor (the connector stops on a migration that holds a delete statement); the paste
-- guide is docs/paste/FXD-06.md. Belongs to 20261006020352_notification_retention_index.sql (apply that one first).
--
-- * app.purge_old_notifications(p_limit default 5000): owner, 18 October 2026: a read notification is removed 90
--   days after it was made, an unread one after 180 days; the audit log keeps the facts. Oldest first, at most
--   p_limit rows a run (1..50,000); returns how many. Nothing references notifications.
-- * app.purge_trash() (body of 0018) now removes at most 1,000 rows of each table a run, oldest in the bin first
--   (the partial deleted_at indexes of 020140 serve it), with the same answer shape and order of tables. A large
--   bin is emptied over several runs instead of one long transaction (the review's "recycle bin in batches",
--   FXD-06). Nothing else changes: still 30 days, still the purge_links trigger per row.
-- * pg_cron: both run every 15 minutes from 01:00 to 04:45 UTC (16 runs a night: up to 80,000 notifications and
--   16,000 rows of each record table); 'crm-purge-trash' was once a night at 02:30. cron.schedule with an existing
--   name updates that job.
-- Security definer (they run from pg_cron), search_path pinned, no client may call them. Safe to run twice.

create or replace function app.purge_old_notifications(p_limit integer default 5000) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.notifications n
   where n.id in (
     select o.id from public.notifications o
      where o.created_at < now() - interval '90 days'
        and (o.read_at is not null or o.created_at < now() - interval '180 days')
      order by o.created_at
      limit greatest(1, least(coalesce(p_limit, 5000), 50000)));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function app.purge_old_notifications(integer) from public, anon, authenticated;

create or replace function app.purge_trash() returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_cutoff timestamptz := now() - interval '30 days';
  v_batch constant integer := 1000;
  v_deals int; v_leads int; v_contacts int; v_companies int; v_tasks int;
begin
  delete from public.deals where id in (
    select x.id from public.deals x where x.deleted_at < v_cutoff order by x.deleted_at limit v_batch);
  get diagnostics v_deals = row_count;
  delete from public.leads where id in (
    select x.id from public.leads x where x.deleted_at < v_cutoff order by x.deleted_at limit v_batch);
  get diagnostics v_leads = row_count;
  delete from public.contacts where id in (
    select x.id from public.contacts x where x.deleted_at < v_cutoff order by x.deleted_at limit v_batch);
  get diagnostics v_contacts = row_count;
  delete from public.companies where id in (
    select x.id from public.companies x where x.deleted_at < v_cutoff order by x.deleted_at limit v_batch);
  get diagnostics v_companies = row_count;
  delete from public.tasks where id in (
    select x.id from public.tasks x where x.deleted_at < v_cutoff order by x.deleted_at limit v_batch);
  get diagnostics v_tasks = row_count;
  return jsonb_build_object('deals', v_deals, 'leads', v_leads, 'contacts', v_contacts, 'companies', v_companies, 'tasks', v_tasks);
end;
$$;
revoke all on function app.purge_trash() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-purge-notifications', '*/15 1-4 * * *', 'select app.purge_old_notifications();');
    perform cron.schedule('crm-purge-trash', '*/15 1-4 * * *', 'select app.purge_trash();');
  end if;
end;
$$;
