-- =============================================================================
-- FXS-07 Files: what was really uploaded, not what the browser said
-- =============================================================================
-- Until now a file's size and type were whatever the browser declared when the
-- row was made, so a file declared as 1 byte could hold 25 MB and slip past the
-- plan's storage cap, and the allowed types were checked only in the server action.
--
-- * The bucket 'record-files' itself takes only the allowed types
--   (app.file_allowed_types(), mirrored by ALLOWED_TYPES in src/features/files/types.ts;
--   a unit test reads this file). SVG, HTML and scripts are not on it.
-- * A row a person makes waits for its upload: files.unconfirmed_since (server only).
--   The object may be put only while its row waits (record_files_insert), so once a
--   file is confirmed nobody can delete its object and put a bigger one in its place.
-- * public.confirm_file_upload(org, file): the uploader, after the upload. It reads the
--   object's real size and type as Storage recorded them (storage.objects.metadata),
--   checks them and the plan's storage again, and then corrects the row and clears
--   the mark, or answers {ok:false, reason} (missing | empty | size | type | quota);
--   the app then removes the object and the row with the user's session.
-- * While a row waits, the storage cap counts the real size of its object when it is
--   known, and a person may have at most 20 rows waiting from the last hour
--   (hint 'file:pending_max'), so uploads that are never confirmed cannot run past the cap.
-- * pg_cron 'crm-file-confirm' (every 5 minutes, app.reconcile_pending_files()) handles
--   uploads whose browser never confirmed: after 10 minutes it confirms what would pass,
--   and otherwise records the real size (so it counts) and leaves the row waiting.
--   It deletes nothing; waiting rows are hidden by the app.
-- * Rows from before this migration, and rows the server makes, never wait.
-- No policy on public.files changes. Every statement is safe to run twice.

alter table public.files add column if not exists unconfirmed_since timestamptz;
alter table public.files add column if not exists upload_checked_at timestamptz;
-- no client grant on either column: table-level select reads them, nobody but the server writes them
create index if not exists files_unconfirmed_idx on public.files (organization_id, uploaded_by, unconfirmed_since)
  where unconfirmed_since is not null;

-- The types a record file may have. Keep equal to ALLOWED_TYPES in src/features/files/types.ts.
create or replace function app.file_allowed_types() returns text[]
language sql immutable
set search_path = ''
as $$
  select array[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/heic',
    'text/plain',
    'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/zip'
  ]::text[]
$$;
revoke all on function app.file_allowed_types() from public, anon, authenticated;

do $$
begin
  -- hosted Supabase has the column (the test shim too, since FXS-07)
  if exists (select 1 from information_schema.columns
              where table_schema = 'storage' and table_name = 'buckets' and column_name = 'allowed_mime_types') then
    execute 'update storage.buckets set allowed_mime_types = $1 where id = ''record-files'''
      using app.file_allowed_types();
  end if;
end;
$$;

-- The object of a record file as Storage recorded it: whether it is there, its size in
-- bytes and its type (lower case, without parameters such as charset). This read of
-- storage.objects relies on the function owner bypassing the storage RLS policies, as
-- in app.org_logo_path_shared (019920).
create or replace function app.record_file_object(p_path text, out present boolean, out size bigint, out mimetype text)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_meta jsonb;
  v_hit  boolean;
begin
  present := false;
  select true, o.metadata into v_hit, v_meta
    from storage.objects o
   where o.bucket_id = 'record-files' and o.name = p_path;
  if not coalesce(v_hit, false) then
    return;
  end if;
  present := true;
  if coalesce(v_meta ->> 'size', '') ~ '^[0-9]{1,15}$' then
    size := (v_meta ->> 'size')::bigint;
  end if;
  mimetype := nullif(lower(btrim(split_part(coalesce(v_meta ->> 'mimetype', ''), ';', 1))), '');
end;
$$;
revoke all on function app.record_file_object(text) from public, anon, authenticated;

-- What is wrong with an uploaded object, or null when nothing is.
create or replace function app.file_upload_problem(p_present boolean, p_size bigint, p_type text) returns text
language sql immutable
set search_path = ''
as $$
  select case
    when not coalesce(p_present, false) or p_size is null then 'missing'
    when p_size < 1 then 'empty'
    when p_size > 26214400 then 'size'
    when p_type is null or not (p_type = any (app.file_allowed_types())) then 'type'
  end
$$;
revoke all on function app.file_upload_problem(boolean, bigint, text) from public, anon, authenticated;

-- The organization's stored bytes, without one file (p_except). A waiting row counts the
-- real size of its object when that is larger than what was declared.
create or replace function app.files_storage_used(p_org uuid, p_except uuid default null) returns bigint
language sql stable security definer
set search_path = ''
as $$
  select coalesce(sum(
           case when f.unconfirmed_since is null then f.size_bytes
                else greatest(f.size_bytes, coalesce((select r.size from app.record_file_object(f.storage_path) r), 0))
           end), 0)::bigint
    from public.files f
   where f.organization_id = p_org
     and (p_except is null or f.id <> p_except)
$$;
revoke all on function app.files_storage_used(uuid, uuid) from public, anon, authenticated;

-- Whether p_bytes more fit under the plan's storage cap (no cap = they fit).
create or replace function app.files_quota_ok(p_org uuid, p_bytes bigint, p_except uuid default null) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_gb numeric := app.org_limit(p_org, 'storage_gb');
begin
  if v_gb is null then
    return true;
  end if;
  return app.files_storage_used(p_org, p_except) + coalesce(p_bytes, 0) <= v_gb * 1024 * 1024 * 1024;
end;
$$;
revoke all on function app.files_quota_ok(uuid, bigint, uuid) from public, anon, authenticated;

-- 0019's trigger, plus the waiting mark, the cap on waiting rows and the real sizes.
create or replace function app.files_before_insert() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_gb  numeric := app.org_limit(new.organization_id, 'storage_gb');
  v_uid uuid := auth.uid();
begin
  new.storage_path := new.organization_id::text || '/' || new.id::text;
  new.uploaded_by := v_uid;
  new.upload_checked_at := null;
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
$$;
revoke all on function app.files_before_insert() from public, anon, authenticated;

-- The uploader, after the upload: check what really arrived.
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

-- Uploads whose browser never confirmed. Confirms what would pass; otherwise records the
-- real size and leaves the row waiting. Each row is looked at again at most once an hour,
-- for 14 days. Deletes nothing.
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
    select f.organization_id, f.id, f.storage_path
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

-- An object may be put only at a path whose row is the caller's and still waits.
alter policy record_files_insert on storage.objects
  with check (bucket_id = 'record-files'
              and exists (select 1 from public.files f
                           where f.storage_path = objects.name
                             and f.uploaded_by = (select auth.uid())
                             and f.unconfirmed_since is not null));

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-file-confirm', '*/5 * * * *', 'select app.reconcile_pending_files();');
  end if;
end;
$$;
