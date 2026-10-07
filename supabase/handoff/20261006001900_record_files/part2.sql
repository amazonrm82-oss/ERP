-- 20261006001900_record_files: part 2 of 3. Run the parts in order.
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
