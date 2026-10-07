-- =============================================================================
-- 0019 Files on records
-- =============================================================================
-- * public.files: one row per file attached to a lead, contact, company or deal.
--   Who sees a file is who sees its record (the same rule as the timeline).
-- * The file itself is in the private Storage bucket 'record-files', at
--   '<organization id>/<file id>' (set by trigger, never by the client). The
--   storage.objects policies point back to public.files, so a file can be read,
--   uploaded or deleted only by someone who may do it to its row.
-- * Up to 25 MB a file. The organization's total is capped by the plan
--   (plans.limits.storage_gb); over it the insert fails with hint 'limit:storage_gb'.
-- * A deleted row leaves its storage path in app.orphan_files, for a cleanup that
--   removes the object through the Storage API (the app deletes the object first
--   when a user deletes a file; a record purged by the nightly job leaves one).
-- Every statement is safe to run twice.

create table if not exists public.files (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  lead_id         uuid,
  contact_id      uuid,
  company_id      uuid,
  deal_id         uuid,
  name            text not null check (char_length(btrim(name)) between 1 and 200),
  mime_type       text not null check (char_length(mime_type) between 1 and 120),
  size_bytes      bigint not null check (size_bytes between 1 and 26214400),
  storage_path    text not null unique,
  uploaded_by     uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete cascade,
  foreign key (organization_id, contact_id) references public.contacts (organization_id, id) on delete cascade,
  foreign key (organization_id, company_id) references public.companies (organization_id, id) on delete cascade,
  foreign key (organization_id, deal_id) references public.deals (organization_id, id) on delete cascade,
  constraint files_one_subject check (num_nonnulls(lead_id, contact_id, company_id, deal_id) = 1),
  constraint files_path check (storage_path = organization_id::text || '/' || id::text)
);
create index if not exists files_lead_idx on public.files (lead_id, created_at desc) where lead_id is not null;
create index if not exists files_contact_idx on public.files (contact_id, created_at desc) where contact_id is not null;
create index if not exists files_company_idx on public.files (company_id, created_at desc) where company_id is not null;
create index if not exists files_deal_idx on public.files (deal_id, created_at desc) where deal_id is not null;
create index if not exists files_org_idx on public.files (organization_id);

alter table public.files enable row level security;
revoke all on public.files from anon, authenticated;
grant select, delete on public.files to authenticated;
grant insert (organization_id, lead_id, contact_id, company_id, deal_id, name, mime_type, size_bytes) on public.files to authenticated;
grant all on public.files to service_role;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'files' and policyname = 'files_select') then
    create policy files_select on public.files for select to authenticated
      using (app.is_member(organization_id) and app.can_read_activity_subject(lead_id, contact_id, company_id, deal_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'files' and policyname = 'files_insert') then
    create policy files_insert on public.files for insert to authenticated
      with check (app.can_write(organization_id) and app.can_read_activity_subject(lead_id, contact_id, company_id, deal_id)
                  and uploaded_by = (select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'files' and policyname = 'files_delete') then
    create policy files_delete on public.files for delete to authenticated
      using (app.can_write(organization_id) and app.can_read_activity_subject(lead_id, contact_id, company_id, deal_id)
             and (uploaded_by = (select auth.uid()) or app.is_admin(organization_id)));
  end if;
end;
$$;

-- the path and the uploader come from the server, and the plan's storage cap holds
create or replace function app.files_before_insert() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_gb   numeric := app.org_limit(new.organization_id, 'storage_gb');
  v_used bigint;
begin
  new.storage_path := new.organization_id::text || '/' || new.id::text;
  new.uploaded_by := auth.uid();
  if v_gb is not null then
    select coalesce(sum(f.size_bytes), 0) into v_used from public.files f where f.organization_id = new.organization_id;
    if v_used + new.size_bytes > v_gb * 1024 * 1024 * 1024 then
      raise exception 'plan storage limit reached (% GB)', v_gb using errcode = 'P0001', hint = 'limit:storage_gb';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.files_before_insert() from public, anon, authenticated;

create or replace trigger files_before_insert before insert on public.files
  for each row execute function app.files_before_insert();
create or replace trigger files_audit after insert or delete on public.files
  for each row execute function app.audit_row();

create table if not exists app.orphan_files (
  storage_path text primary key,
  deleted_at   timestamptz not null default now()
);
revoke all on app.orphan_files from public, anon, authenticated;

create or replace function app.files_after_delete() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into app.orphan_files (storage_path) values (old.storage_path) on conflict do nothing;
  return old;
end;
$$;
revoke all on function app.files_after_delete() from public, anon, authenticated;

create or replace trigger files_after_delete after delete on public.files
  for each row execute function app.files_after_delete();

-- the private bucket, 25 MB a file
insert into storage.buckets (id, name, public, file_size_limit)
values ('record-files', 'record-files', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = 26214400;

-- Storage follows public.files: the subqueries run with the caller's rights, so
-- the files policies above decide. objects.name is qualified on purpose: files
-- has a column called name too.
drop policy if exists record_files_select on storage.objects;
create policy record_files_select on storage.objects for select to authenticated
  using (bucket_id = 'record-files' and exists (select 1 from public.files f where f.storage_path = objects.name));
drop policy if exists record_files_insert on storage.objects;
create policy record_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'record-files'
              and exists (select 1 from public.files f where f.storage_path = objects.name and f.uploaded_by = (select auth.uid())));
drop policy if exists record_files_delete on storage.objects;
create policy record_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'record-files'
         and exists (select 1 from public.files f
                      where f.storage_path = objects.name and app.can_write(f.organization_id)
                        and (f.uploaded_by = (select auth.uid()) or app.is_admin(f.organization_id))));
