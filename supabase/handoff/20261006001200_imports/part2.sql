-- 20261006001200_imports: part 2 of 4. Run the parts in order.
-- ----------------------------------------------------------------------------
-- Access
-- ----------------------------------------------------------------------------
alter table public.import_jobs enable row level security;
revoke all on public.import_jobs from anon, authenticated;
grant all on public.import_jobs to service_role;
grant select on public.import_jobs to authenticated;
grant insert (organization_id, entity_type, file_name, duplicate_mode, total_rows) on public.import_jobs to authenticated;
grant update (status, created_count, updated_count, skipped_count, failed_count, finished_at, undone_at)
  on public.import_jobs to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'import_jobs' and policyname = 'import_jobs_select') then
    create policy import_jobs_select on public.import_jobs for select to authenticated
      using (app.is_member(organization_id) and (created_by = (select auth.uid()) or app.is_admin(organization_id)));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'import_jobs' and policyname = 'import_jobs_insert') then
    create policy import_jobs_insert on public.import_jobs for insert to authenticated
      with check (app.can_import(organization_id) and created_by = (select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'import_jobs' and policyname = 'import_jobs_update') then
    create policy import_jobs_update on public.import_jobs for update to authenticated
      using (app.can_import(organization_id) and created_by = (select auth.uid()))
      with check (app.can_import(organization_id) and created_by = (select auth.uid()));
  end if;
end;
$$;

-- touch_row: created_by is the session's user, organization_id cannot change
create or replace trigger import_jobs_touch before insert or update on public.import_jobs
  for each row execute function app.touch_row();

-- ----------------------------------------------------------------------------
-- A record may carry only a running import of the same user and type, set on insert
-- ----------------------------------------------------------------------------
create or replace function app.guard_import_tag() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.import_job_id is distinct from old.import_job_id and auth.uid() is not null then
      raise exception 'import_job_id cannot be changed' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.import_job_id is not null and auth.uid() is not null and not exists (
    select 1 from public.import_jobs j
     where j.organization_id = new.organization_id and j.id = new.import_job_id
       and j.created_by = auth.uid() and j.status = 'running' and j.entity_type = tg_argv[0]) then
    raise exception 'not a running import of this user' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace trigger leads_import_tag before insert or update of import_job_id on public.leads
  for each row execute function app.guard_import_tag('lead');
create or replace trigger contacts_import_tag before insert or update of import_job_id on public.contacts
  for each row execute function app.guard_import_tag('contact');
create or replace trigger companies_import_tag before insert or update of import_job_id on public.companies
  for each row execute function app.guard_import_tag('company');
