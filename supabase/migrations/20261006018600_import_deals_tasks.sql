-- =============================================================================
-- Deals and tasks: import from Excel/CSV (IMP-03, wave 2)
-- =============================================================================
-- The import wizard (src/features/imports/) learns two more objects, 'deal' and
-- 'task', the same way leads, contacts and companies work since 0012 and
-- products since 0159:
--
-- * import_jobs.entity_type also takes 'deal' and 'task'. Who may import is
--   unchanged (app.can_import: owners, admins and team managers of a writable
--   organization), as for leads; RLS still decides each row.
-- * deals.import_job_id and tasks.import_job_id remember which import created a
--   record. Set on insert only, to a running job of the same user and type
--   (app.guard_import_tag('deal' | 'task'), the function of 0044 unchanged), and
--   never changed. deals has table-level grants (the guard refuses a change);
--   tasks has column-level grants (TASK-04), so the column gets an insert grant
--   only.
-- * app.emit_event() and app.notify_assignment() already read import_job_id
--   through to_jsonb(new), so an imported deal or task is marked origin
--   'import' in the outbox (automations skip it) and sends no "assigned to you"
--   notification. Nothing to redefine there.
-- * Undo runs in the app with the user's session: the imported deals and tasks
--   go to deleted_at, like leads, contacts and companies (tasks have no recycle
--   bin screen; app.purge_trash() removes them after 30 days like the others).
-- * public.deal_name_matches(org, names) finds the live deals whose whole name
--   equals one of the given ones (a task row links a deal by its name). Security
--   invoker: RLS decides, like product_sku_matches. The names travel in the
--   request body, so quotes and commas are safe.
-- * app.fail_stale_imports() counts the deals and tasks of a stale import (its
--   body is that of 0159 with two more branches).
--
-- Every statement is safe to run twice. No drops, no row removal.

alter table public.import_jobs drop constraint if exists import_jobs_entity_type_check;
alter table public.import_jobs add constraint import_jobs_entity_type_check
  check (entity_type in ('lead', 'contact', 'company', 'product', 'deal', 'task'));

alter table public.deals add column if not exists import_job_id uuid;
alter table public.tasks add column if not exists import_job_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'deals_import_job_fk') then
    alter table public.deals add constraint deals_import_job_fk foreign key (organization_id, import_job_id)
      references public.import_jobs (organization_id, id) on delete set null (import_job_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_import_job_fk') then
    alter table public.tasks add constraint tasks_import_job_fk foreign key (organization_id, import_job_id)
      references public.import_jobs (organization_id, id) on delete set null (import_job_id);
  end if;
end;
$$;
create index if not exists deals_import_job_idx on public.deals (import_job_id) where import_job_id is not null;
create index if not exists tasks_import_job_idx on public.tasks (import_job_id) where import_job_id is not null;

-- tasks: set on insert by the import; never updated by a client (TASK-04 column grants)
grant insert (import_job_id) on public.tasks to authenticated;

create or replace trigger deals_import_tag before insert or update of import_job_id on public.deals
  for each row execute function app.guard_import_tag('deal');
create or replace trigger tasks_import_tag before insert or update of import_job_id on public.tasks
  for each row execute function app.guard_import_tag('task');

create or replace function public.deal_name_matches(p_org uuid, p_names text[])
returns table (id uuid, name text)
language sql stable
set search_path = ''
as $$
  select d.id, d.name
    from public.deals d
   where d.organization_id = p_org
     and d.deleted_at is null
     and d.name = any (coalesce(p_names, '{}'::text[]))
$$;
revoke all on function public.deal_name_matches(uuid, text[]) from public, anon;
create index if not exists deals_name_idx on public.deals (organization_id, name) where deleted_at is null;
grant execute on function public.deal_name_matches(uuid, text[]) to authenticated;

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
           when 'product' then (select count(*) from public.products p where p.organization_id = j.organization_id and p.import_job_id = j.id)
           when 'deal' then (select count(*) from public.deals d where d.organization_id = j.organization_id and d.import_job_id = j.id)
           when 'task' then (select count(*) from public.tasks t where t.organization_id = j.organization_id and t.import_job_id = j.id)
           else (select count(*) from public.companies o where o.organization_id = j.organization_id and o.import_job_id = j.id)
         end
   where j.status = 'running' and j.updated_at < now() - interval '10 minutes';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function app.fail_stale_imports() from public, anon, authenticated;
grant execute on function app.fail_stale_imports() to service_role;

notify pgrst, 'reload schema';
