-- =============================================================================
-- 0045 An interrupted import is closed and can be undone (FXC-03)
-- =============================================================================
-- The browser sends an import in chunks. When the tab was closed or the
-- connection dropped, the job stayed "running" for ever: its records could not
-- be undone, and nothing told the user it had stopped.
-- * Every chunk touches its job first (the app updates status to 'running',
--   which moves updated_at), so a job that is really running is never idle long.
-- * app.fail_stale_imports() marks a job that has had no chunk for 10 minutes
--   as failed, with the number of records it created, so it can be undone like
--   any finished import. pg_cron runs it every 5 minutes.
-- Every statement is safe to run twice.

create or replace function app.fail_stale_imports() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.import_jobs j
     set status = 'failed',
         finished_at = now(),
         created_count = case j.entity_type
           when 'lead' then (select count(*) from public.leads l where l.organization_id = j.organization_id and l.import_job_id = j.id)
           when 'contact' then (select count(*) from public.contacts c where c.organization_id = j.organization_id and c.import_job_id = j.id)
           else (select count(*) from public.companies o where o.organization_id = j.organization_id and o.import_job_id = j.id)
         end
   where j.status = 'running' and j.updated_at < now() - interval '10 minutes';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function app.fail_stale_imports() from public, anon, authenticated;
grant execute on function app.fail_stale_imports() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-stale-imports', '*/5 * * * *', 'select app.fail_stale_imports()');
  end if;
end;
$$;
