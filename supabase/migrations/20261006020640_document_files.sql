-- =============================================================================
-- A file on an external accounting document (DOC-01 follow-up; lane ד, the shared files mechanism)
-- =============================================================================
-- * files.accounting_document_id: a file may belong to one recorded document instead of a lead, contact, company or deal
--   (files_one_subject now counts the document; composite foreign key, on delete cascade: a document is never deleted,
--   so in practice only its business's deletion takes the files). A document's file is never on a timeline entry.
-- * Who: reading follows the document (accounting_documents_select: its deal, else its contact, else owners, admins and
--   managers); adding needs the document rules (app.can_record_documents in a writable business with the `documents`
--   flag) besides app.can_write. The files policies branch on the column, so a record's file keeps exactly its rules of
--   020210.
-- * Never removed (owner, 20 October 2026, DECISIONS.md): nobody deletes a document's file, owners and admins included; a
--   wrong file is replaced by a new version (the earlier ones stay) or the document is cancelled with a reason. The delete
--   policy refuses it, the Storage delete policy keeps its object, and trigger files_keep_attached refuses it for every
--   writer, definer paths included. Two exceptions: the business's own deletion (its cascade), and an upload that never
--   arrived (a row still waiting for confirm_file_upload, which only its uploader removes, as the app does when an upload
--   fails).
-- * A cancelled document takes files too: cancelling records why the document no longer counts, but the paper that was
--   issued still exists and is what an accountant asks for; a file adds nothing to the document's frozen facts (type,
--   number, date, amount), and every file is audited with its uploader.
-- * Only PDF and images (app.document_file_types), checked when the row is made and again on the real object by
--   public.confirm_file_upload / app.reconcile_pending_files (reason 'type').
-- * One current file per document: the server links a new file to the document's latest file (files.previous_id, the
--   REC-07 versions), under a lock per document, read with the caller's rights in app.files_links_check. A person who
--   names an earlier version that is no longer the latest is refused (hint file:version_taken).
-- * Storage reads public.files with the caller's rights as before; its delete policy also keeps a document's file.
-- Every statement is safe to run twice. No drops, no row removal.

alter table public.files add column if not exists accounting_document_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'files_accounting_document_fk') then
    alter table public.files add constraint files_accounting_document_fk
      foreign key (organization_id, accounting_document_id) references public.accounting_documents (organization_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'files_document_no_note') then
    alter table public.files add constraint files_document_no_note check (accounting_document_id is null or activity_id is null);
  end if;
end;
$$;

-- one subject each: a record, or a document (every existing row has a record)
alter table public.files drop constraint if exists files_one_subject;
alter table public.files add constraint files_one_subject
  check (num_nonnulls(lead_id, contact_id, company_id, deal_id, accounting_document_id) = 1);

create index if not exists files_accounting_document_idx on public.files (organization_id, accounting_document_id);

grant insert (accounting_document_id) on public.files to authenticated;

-- The types a document's file may have: PDF and images (a subset of app.file_allowed_types). Keep equal to
-- DOCUMENT_FILE_TYPES in src/features/files/types.ts.
create or replace function app.document_file_types() returns text[]
language sql immutable
set search_path = ''
as $$
  select array['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic']::text[]
$$;
revoke all on function app.document_file_types() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Policies: a document's file follows the document; a record's file keeps the rules of 020210
-- ----------------------------------------------------------------------------
alter policy files_select on public.files
  using (app.is_member(organization_id)
         and case when accounting_document_id is not null
                  then exists (select 1 from public.accounting_documents d
                                where d.organization_id = files.organization_id and d.id = files.accounting_document_id)
                  else app.can_read_activity_subject(lead_id, contact_id, company_id, deal_id)
                       and (activity_id is null
                            or exists (select 1 from public.activities a
                                        where a.organization_id = files.organization_id and a.id = files.activity_id))
             end);
alter policy files_insert on public.files
  with check (app.can_write(organization_id)
              and uploaded_by = (select auth.uid())
              and case when accounting_document_id is not null
                       then app.can_record_documents(organization_id) and app.org_writable(organization_id)
                            and app.org_has_feature(organization_id, 'documents')
                            and exists (select 1 from public.accounting_documents d
                                         where d.organization_id = files.organization_id and d.id = files.accounting_document_id)
                       else app.can_read_activity_subject(lead_id, contact_id, company_id, deal_id)
                            and (activity_id is null
                                 or exists (select 1 from public.activities a
                                             where a.organization_id = files.organization_id and a.id = files.activity_id))
                  end);
alter policy files_delete on public.files
  using (app.can_write(organization_id)
         and (uploaded_by = (select auth.uid()) or app.is_admin(organization_id))
         and case when accounting_document_id is not null
                  -- never removed (owner); only the uploader's own upload that never arrived goes
                  then unconfirmed_since is not null and uploaded_by = (select auth.uid())
                  else app.can_read_activity_subject(lead_id, contact_id, company_id, deal_id)
                       and (activity_id is null
                            or exists (select 1 from public.activities a
                                        where a.organization_id = files.organization_id and a.id = files.activity_id))
             end);

-- Storage keeps the object of a document's file (the row is kept): only an upload that never arrived goes
alter policy record_files_delete on storage.objects
  using (bucket_id = 'record-files'
         and exists (select 1 from public.files f
                      where f.storage_path = objects.name and app.can_write(f.organization_id)
                        and (f.uploaded_by = (select auth.uid()) or app.is_admin(f.organization_id))
                        and (f.accounting_document_id is null
                             or (f.unconfirmed_since is not null and f.uploaded_by = (select auth.uid())))));

-- For every writer, definer paths included: a document's file is never deleted, but with its business or while its upload
-- never arrived
create or replace function app.files_keep_attached() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if old.accounting_document_id is not null and old.unconfirmed_since is null and app.org_exists(old.organization_id) then
    raise exception 'a document''s file is kept; add a new version instead' using errcode = 'P0001', hint = 'file:kept';
  end if;
  return old;
end;
$$;
revoke all on function app.files_keep_attached() from public, anon, authenticated;

create or replace trigger files_keep_attached before delete on public.files
  for each row execute function app.files_keep_attached();

-- ----------------------------------------------------------------------------
-- The path, the uploader, the waiting state and the quota (020445), plus a document's flag and types
-- ----------------------------------------------------------------------------
create or replace function app.files_before_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_gb  numeric := app.org_limit(new.organization_id, 'storage_gb');
  v_uid uuid := auth.uid();
begin
  new.storage_path := new.organization_id::text || '/' || new.id::text;
  new.uploaded_by := v_uid;
  new.upload_checked_at := null;
  -- RVW-23: a caller the write policy refuses gets RLS's plain 42501, never this business's quota or plan
  if auth.uid() is not null
     and not (app.can_write(new.organization_id)
              and (new.accounting_document_id is null
                   or (app.can_record_documents(new.organization_id) and app.org_writable(new.organization_id)))) then
    return new;
  end if;
  -- a document's file: the plan's flag, and PDF or an image only
  if new.accounting_document_id is not null then
    if not app.org_has_feature(new.organization_id, 'documents') then
      raise exception 'accounting documents are not in the plan' using errcode = 'P0001', hint = 'feature:documents';
    end if;
    if not (lower(coalesce(new.mime_type, '')) = any (app.document_file_types())) then
      raise exception 'a document''s file is a PDF or an image' using errcode = 'P0001', hint = 'file:document_type';
    end if;
  end if;
  if v_uid is not null then
    -- FXS-07: a person's row waits until its upload is confirmed
    new.unconfirmed_since := now();
    perform pg_advisory_xact_lock(hashtextextended('files_pending:' || new.organization_id::text || ':' || v_uid::text, 0));
    if (select count(*) from public.files f
         where f.organization_id = new.organization_id and f.uploaded_by = v_uid
           and f.unconfirmed_since > now() - interval '1 hour') >= 20 then
      raise exception 'too many uploads are waiting for confirmation' using errcode = 'P0001', hint = 'file:pending_max';
    end if;
  end if;
  if v_gb is not null then
    perform pg_advisory_xact_lock(hashtextextended('files_quota:' || new.organization_id::text, 0));
    if not app.files_quota_ok(new.organization_id, new.size_bytes) then
      raise exception 'plan storage limit reached (% GB)', v_gb using errcode = 'P0001', hint = 'limit:storage_gb';
    end if;
  end if;
  return new;
end;
$function$;
revoke all on function app.files_before_insert() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Links (020210), plus: a document's new file follows its latest file. Security invoker, so the latest file is read
-- with the caller's rights (those of the document), and the lock keeps two uploads from both starting a history.
-- ----------------------------------------------------------------------------
create or replace function app.files_links_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_note public.activities;
  v_prev public.files;
  v_latest uuid;
  v_person boolean := current_user in ('authenticated', 'anon');
begin
  -- a person who may not write here gets RLS's plain refusal right after
  if v_person and not app.can_write(new.organization_id) then
    return new;
  end if;
  if new.accounting_document_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('files_document:' || new.organization_id::text || ':' || new.accounting_document_id::text, 0));
    -- the latest file: the one no other file of the document replaces (the history is one line)
    select f.id into v_latest
      from public.files f
     where f.organization_id = new.organization_id and f.accounting_document_id = new.accounting_document_id
       and not exists (select 1 from public.files n where n.organization_id = f.organization_id and n.previous_id = f.id)
     order by f.created_at desc, f.id desc
     limit 1;
    if new.previous_id is not null and new.previous_id is distinct from v_latest then
      raise exception 'this document already has a newer file' using errcode = 'P0001', hint = 'file:version_taken';
    end if;
    new.previous_id := v_latest;
  end if;
  if new.activity_id is not null then
    select * into v_note from public.activities a where a.organization_id = new.organization_id and a.id = new.activity_id;
    if not found
       or v_note.lead_id is distinct from new.lead_id or v_note.contact_id is distinct from new.contact_id
       or v_note.company_id is distinct from new.company_id or v_note.deal_id is distinct from new.deal_id
       or (v_person and (v_note.type not in ('note', 'call', 'meeting', 'email', 'whatsapp', 'sms')
                         or v_note.created_by is distinct from auth.uid())) then
      raise exception 'a file is attached only to an entry of the same record, by its author'
        using errcode = 'P0001', hint = 'file:note';
    end if;
  end if;
  if new.previous_id is not null then
    select * into v_prev from public.files f where f.organization_id = new.organization_id and f.id = new.previous_id;
    if not found
       or v_prev.lead_id is distinct from new.lead_id or v_prev.contact_id is distinct from new.contact_id
       or v_prev.company_id is distinct from new.company_id or v_prev.deal_id is distinct from new.deal_id
       or v_prev.activity_id is distinct from new.activity_id
       or v_prev.accounting_document_id is distinct from new.accounting_document_id then
      raise exception 'a new version belongs to the same record and note as the earlier one'
        using errcode = 'P0001', hint = 'file:version';
    end if;
    if exists (select 1 from public.files f where f.previous_id = new.previous_id) then
      raise exception 'this file already has a newer version' using errcode = 'P0001', hint = 'file:version_taken';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.files_links_check() from public, anon;
grant execute on function app.files_links_check() to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The real object (020255): a document's file must really be a PDF or an image
-- ----------------------------------------------------------------------------
create or replace function public.confirm_file_upload(p_org uuid, p_file uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_file    public.files%rowtype;
  v_obj     record;
  v_problem text;
begin
  if v_uid is null or not app.is_member(p_org) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('files_quota:' || p_org::text, 0));
  select * into v_file from public.files f where f.organization_id = p_org and f.id = p_file for update;
  if not found or v_file.uploaded_by is distinct from v_uid then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_file.unconfirmed_since is null then
    return jsonb_build_object('ok', true);
  end if;
  select * into v_obj from app.record_file_object(v_file.storage_path);
  v_problem := app.file_upload_problem(v_obj.present, v_obj.size, v_obj.mimetype);
  if v_problem is null and v_file.accounting_document_id is not null and not (v_obj.mimetype = any (app.document_file_types())) then
    v_problem := 'type';
  end if;
  if v_problem is null and not app.files_quota_ok(p_org, v_obj.size, p_file) then
    v_problem := 'quota';
  end if;
  if v_problem is not null then
    -- the row keeps waiting (hidden); a larger real size counts against the cap until it is removed
    update public.files f
       set size_bytes = case when v_obj.size between 1 and 26214400 and v_obj.size > f.size_bytes then v_obj.size else f.size_bytes end,
           upload_checked_at = now()
     where f.organization_id = p_org and f.id = p_file;
    return jsonb_build_object('ok', false, 'reason', v_problem);
  end if;
  update public.files f
     set size_bytes = v_obj.size, mime_type = v_obj.mimetype, unconfirmed_since = null, upload_checked_at = now()
   where f.organization_id = p_org and f.id = p_file;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.confirm_file_upload(uuid, uuid) from public, anon;
grant execute on function public.confirm_file_upload(uuid, uuid) to authenticated;

create or replace function app.reconcile_pending_files(p_limit integer default 500) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  r         record;
  v_obj     record;
  v_problem text;
  v_done    integer := 0;
begin
  for r in
    select f.organization_id, f.id, f.storage_path, f.accounting_document_id
      from public.files f
     where f.unconfirmed_since is not null
       and f.unconfirmed_since < now() - interval '10 minutes'
       and f.unconfirmed_since > now() - interval '14 days'
       and (f.upload_checked_at is null or f.upload_checked_at < now() - interval '1 hour')
     order by f.upload_checked_at nulls first, f.unconfirmed_since
     limit greatest(1, least(coalesce(p_limit, 500), 5000))
     for update skip locked
  loop
    begin
      perform pg_advisory_xact_lock(hashtextextended('files_quota:' || r.organization_id::text, 0));
      select * into v_obj from app.record_file_object(r.storage_path);
      v_problem := app.file_upload_problem(v_obj.present, v_obj.size, v_obj.mimetype);
      if v_problem is null and r.accounting_document_id is not null and not (v_obj.mimetype = any (app.document_file_types())) then
        v_problem := 'type';
      end if;
      if v_problem is null and not app.files_quota_ok(r.organization_id, v_obj.size, r.id) then
        v_problem := 'quota';
      end if;
      if v_problem is null then
        update public.files f
           set size_bytes = v_obj.size, mime_type = v_obj.mimetype, unconfirmed_since = null, upload_checked_at = now()
         where f.organization_id = r.organization_id and f.id = r.id;
      else
        update public.files f
           set size_bytes = case when v_obj.size between 1 and 26214400 and v_obj.size > f.size_bytes then v_obj.size else f.size_bytes end,
               upload_checked_at = now()
         where f.organization_id = r.organization_id and f.id = r.id;
      end if;
      v_done := v_done + 1;
    exception when others then
      raise warning 'reconcile_pending_files: file % skipped: %', r.id, sqlerrm;
    end;
  end loop;
  return v_done;
end;
$$;
revoke all on function app.reconcile_pending_files(integer) from public, anon, authenticated;

notify pgrst, 'reload schema';
