-- 20261006020355_retention_purge: part 2 of 2. Run the parts in order.
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
