-- 20261006001200_imports: part 1 of 4. Run the parts in order.
-- =============================================================================
-- 0012 Imports: import jobs, and records that remember which import made them
-- =============================================================================
-- * import_jobs: one row per file imported (who, what, how many, status).
--   Owners, admins and team managers may import (app.can_import).
-- * leads / contacts / companies get import_job_id. A record may be tagged only
--   with a running job of the same user and type, and the tag cannot be changed
--   later. Undoing an import moves the records it created to the recycle bin.
-- * Imported records do not start automations and do not send "assigned to you"
--   notifications: a file of 5,000 leads must not create 5,000 tasks. Their
--   outbox events carry payload.origin = 'import'.
-- Every statement is safe to run twice.

create or replace function app.can_import(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app.org_writable(p_org) and coalesce(app.role_in(p_org)::text in ('owner', 'admin', 'manager'), false);
$$;

create table if not exists public.import_jobs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  entity_type     text not null check (entity_type in ('lead', 'contact', 'company')),
  file_name       text not null check (char_length(file_name) between 1 and 255),
  duplicate_mode  text not null check (duplicate_mode in ('skip', 'update', 'create')),
  status          text not null default 'running' check (status in ('running', 'done', 'failed', 'undone')),
  total_rows      integer not null default 0 check (total_rows between 0 and 50000),
  created_count   integer not null default 0 check (created_count >= 0),
  updated_count   integer not null default 0 check (updated_count >= 0),
  skipped_count   integer not null default 0 check (skipped_count >= 0),
  failed_count    integer not null default 0 check (failed_count >= 0),
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  finished_at     timestamptz,
  undone_at       timestamptz,
  unique (organization_id, id)
);

create index if not exists import_jobs_org_idx on public.import_jobs (organization_id, created_at desc);

alter table public.leads add column if not exists import_job_id uuid;
alter table public.contacts add column if not exists import_job_id uuid;
alter table public.companies add column if not exists import_job_id uuid;

do $$
declare
  t text;
begin
  foreach t in array array['leads', 'contacts', 'companies'] loop
    if not exists (select 1 from pg_constraint where conname = t || '_import_job_fk') then
      execute format(
        'alter table public.%1$I add constraint %1$s_import_job_fk foreign key (organization_id, import_job_id)
           references public.import_jobs (organization_id, id) on delete set null (import_job_id)', t);
    end if;
    execute format('create index if not exists %1$s_import_job_idx on public.%1$I (import_job_id) where import_job_id is not null', t);
  end loop;
end;
$$;
