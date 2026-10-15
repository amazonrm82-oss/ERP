-- =============================================================================
-- Business logos that are not in use go through the nightly file cleanup (FLD-04 follow-up)
-- =============================================================================
-- Owner's decision, 14 October 2026 (DECISIONS.md, FLD-04): a logo that is no longer in use is removed
-- by the nightly cleanup, exactly like profile photos (USR-01, migration avatar_cleanup). This extends
-- the service-role key's existing cleanup use to the bucket 'org-logos' and to nothing else: the
-- database records the path, pg_cron wakes /api/files/cleanup with the shared secret, the route claims
-- paths, removes the objects with the service role only from the buckets in CLEANUP_BUCKETS
-- (src/features/files/orphans.ts) and reports them done.
--
-- * app.orphan_files.bucket also takes 'org-logos' (logo paths '<org id>/<uuid>' are fresh uuids, like
--   record files and photos, so storage_path stays the key).
-- * Trigger organizations_logo_orphans (security definer), modelled on profiles_avatar_orphans:
--   - a replaced or cleared logo queues the old path, only when it lies in the organization's own folder
--     (app.org_logo_org). The app already removes it with the user's session; this is the safety net.
--   - a deleted organization queues its logo and every other object in its own folder of 'org-logos'
--     (uploads that never became the logo), as a deleted profile does for its photo folder.
--   - an update that does not change logo_path queues nothing.
--   - a path that is also a record file's path is never queued as a logo (review, 15 October 2026):
--     app.orphan_files is keyed on storage_path alone, and record files use the same '<org>/<uuid>' shape,
--     so an owner could name a logo upload after one of the business's files. Queuing it as 'org-logos'
--     would make the file's own queue row a no-op when the file is deleted, and the record-files object
--     would stay. app.org_logo_path_shared() skips a path that public.files holds (any business), that is
--     already queued under another bucket, or that exists as an object in 'record-files'. Such a logo
--     object is then left in storage, by design (the safe side: never a record file left behind).
-- * app.orphan_claimable(): an 'org-logos' path is claimed only while it has the '<org id>/<uuid>' shape
--   and is not some organization's current logo_path (a logo set again waits; queued again later is a
--   no-op on the existing row). public.claim_orphan_objects() and app.cleanup_files() read it and are
--   unchanged; public.claim_orphan_files() (old app code) still returns record-files only.
-- Nothing here removes rows or objects. Every statement is safe to run twice.

alter table app.orphan_files drop constraint if exists orphan_files_bucket_check;
alter table app.orphan_files add constraint orphan_files_bucket_check check (bucket in ('record-files', 'avatars', 'org-logos'));

-- True when the queued object may be removed now: an avatar or logo that is in use again (or still) is left alone.
create or replace function app.orphan_claimable(p_bucket text, p_path text) returns boolean
language sql stable
set search_path = ''
as $$
  select p_bucket = 'record-files'
      or (p_bucket = 'avatars' and not exists (select 1 from public.profiles p where p.avatar_url = p_path))
      or (p_bucket = 'org-logos' and app.org_logo_org(p_path) is not null
          and not exists (select 1 from public.organizations o where o.logo_path = p_path))
$$;
revoke all on function app.orphan_claimable(text, text) from public, anon, authenticated;

-- True when a logo path is also used outside the logo bucket, so it must not be queued as a logo.
create or replace function app.org_logo_path_shared(p_path text) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.files f where f.storage_path = p_path)
     or exists (select 1 from app.orphan_files q where q.storage_path = p_path and q.bucket <> 'org-logos') then
    return true;
  end if;
  -- Needs the function owner to bypass the storage RLS policies (role postgres on Supabase); without that
  -- the two checks above still hold (a record file's object exists only while its row or its queue row does).
  begin
    return exists (select 1 from storage.objects o where o.bucket_id = 'record-files' and o.name = p_path);
  exception when insufficient_privilege then
    raise warning 'org_logo_path_shared: cannot read storage.objects; path % was checked against record files and the cleanup queue only', p_path;
    return false;
  end;
end;
$$;
revoke all on function app.org_logo_path_shared(text) from public, anon, authenticated;

create or replace function app.organizations_logo_orphans() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if app.org_logo_org(old.logo_path) = old.id and not app.org_logo_path_shared(old.logo_path) then
      insert into app.orphan_files (storage_path, bucket) values (old.logo_path, 'org-logos') on conflict do nothing;
    end if;
    -- Uploads in the organization's own folder that never became the logo. Like profiles_avatar_orphans,
    -- this read of storage.objects relies on the function owner bypassing the storage RLS policies (role
    -- postgres on Supabase); without that only the logo above is queued and a warning is left in the log.
    begin
      insert into app.orphan_files (storage_path, bucket)
      select o.name, 'org-logos' from storage.objects o
       where o.bucket_id = 'org-logos'
         and o.name like old.id::text || '/%'
         and app.org_logo_org(o.name) = old.id
         and not app.org_logo_path_shared(o.name)
      on conflict do nothing;
    exception when insufficient_privilege then
      raise warning 'organizations_logo_orphans: cannot read storage.objects; only the current logo of organization % was queued for cleanup', old.id;
    end;
    return old;
  end if;
  if app.org_logo_org(old.logo_path) = old.id and new.logo_path is distinct from old.logo_path
     and not app.org_logo_path_shared(old.logo_path) then
    insert into app.orphan_files (storage_path, bucket) values (old.logo_path, 'org-logos') on conflict do nothing;
  end if;
  return new;
end;
$$;
revoke all on function app.organizations_logo_orphans() from public, anon, authenticated;

create or replace trigger organizations_logo_orphans after update of logo_path or delete on public.organizations
  for each row execute function app.organizations_logo_orphans();
