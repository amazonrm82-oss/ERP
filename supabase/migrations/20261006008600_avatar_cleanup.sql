-- =============================================================================
-- Profile photos of deleted accounts go through the nightly file cleanup (USR-01)
-- =============================================================================
-- Owner's decision, 12 October 2026: the photo of a deleted account is removed
-- automatically, only through the existing nightly cleanup (0021): the database
-- records the path, pg_cron wakes /api/files/cleanup with the shared secret, the
-- route claims paths, removes the objects with the service role and reports them
-- done. No new place uses the service-role key.
--
-- * app.orphan_files gets a bucket column: 'record-files' (the default, so the
--   existing files trigger is unchanged) or 'avatars'; a check allows only these
--   two. Avatar paths ('<user id>/<uuid>') and file paths ('<org id>/<uuid>') do
--   not collide, so storage_path stays the key.
-- * Trigger profiles_avatar_orphans (security definer, insert only):
--   - a deleted profile (auth.users deleted -> profiles cascade) queues its
--     avatar_url when it is in the user's own folder, plus every other object in the user's folder (uploads that
--     never became the photo);
--   - a changed or removed photo queues the old path (own folder only). The app already deletes it
--     with the user's session; this is the safety net when that fails.
-- * An avatar path that is still some profile's photo is never claimed (it waits;
--   a later change queues it again, which is a no-op on the existing row).
-- * public.claim_orphan_files() (old app code, record-files only) keeps its shape
--   and now returns record-files paths only, so code that runs until the deploy
--   finishes never takes an avatar path, removes it from the wrong bucket and
--   reports it done. The new app code calls public.claim_orphan_objects(), which
--   returns [{"bucket": ..., "path": ...}]; public.finish_orphan_files() is
--   unchanged (paths are unique across both buckets).
-- * app.cleanup_files() wakes the app only when something is claimable.
-- Nothing here removes rows or objects; finish_orphan_files() (0021) is unchanged.
-- Every statement is safe to run twice.

alter table app.orphan_files add column if not exists bucket text not null default 'record-files';

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'app.orphan_files'::regclass and conname = 'orphan_files_bucket_check') then
    alter table app.orphan_files add constraint orphan_files_bucket_check check (bucket in ('record-files', 'avatars'));
  end if;
end;
$$;

-- True when the queued object may be removed now: an avatar that is some
-- profile's photo again (or still) is left alone.
create or replace function app.orphan_claimable(p_bucket text, p_path text) returns boolean
language sql stable
set search_path = ''
as $$
  select p_bucket = 'record-files'
      or (p_bucket = 'avatars' and not exists (select 1 from public.profiles p where p.avatar_url = p_path))
$$;
revoke all on function app.orphan_claimable(text, text) from public, anon, authenticated;

create or replace function app.profiles_avatar_orphans() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if app.avatar_owner(old.avatar_url) = old.id then
      insert into app.orphan_files (storage_path, bucket) values (old.avatar_url, 'avatars') on conflict do nothing;
    end if;
    -- Uploads in the user's own folder that never became the photo. This read of
    -- storage.objects relies on the function owner bypassing the storage RLS
    -- policies (true for role postgres on Supabase, which has bypassrls). Without
    -- that it finds nothing, or raises; then only the photo above is queued and a
    -- warning is left in the log. The like prefix lets the (bucket_id, name)
    -- index be used; avatar_owner keeps the exact shape check.
    begin
      insert into app.orphan_files (storage_path, bucket)
      select o.name, 'avatars' from storage.objects o
       where o.bucket_id = 'avatars'
         and o.name like old.id::text || '/%'
         and app.avatar_owner(o.name) = old.id
      on conflict do nothing;
    exception when insufficient_privilege then
      raise warning 'profiles_avatar_orphans: cannot read storage.objects; only the current photo of user % was queued for cleanup', old.id;
    end;
    return old;
  end if;
  if app.avatar_owner(old.avatar_url) = old.id and new.avatar_url is distinct from old.avatar_url then
    insert into app.orphan_files (storage_path, bucket) values (old.avatar_url, 'avatars') on conflict do nothing;
  end if;
  return new;
end;
$$;
revoke all on function app.profiles_avatar_orphans() from public, anon, authenticated;

create or replace trigger profiles_avatar_orphans after update of avatar_url or delete on public.profiles
  for each row execute function app.profiles_avatar_orphans();

-- Old app code (before this deploy): record-files only, shape unchanged.
create or replace function public.claim_orphan_files(p_limit integer default 500) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_paths jsonb;
begin
  with batch as (
    select o.storage_path from app.orphan_files o
     where o.bucket = 'record-files'
       and (o.claimed_at is null or o.claimed_at < now() - interval '1 hour')
     order by o.deleted_at
     limit least(greatest(coalesce(p_limit, 500), 1), 1000)
     for update skip locked
  ), claimed as (
    update app.orphan_files o set claimed_at = now()
      from batch where o.storage_path = batch.storage_path
    returning o.storage_path
  )
  select coalesce(jsonb_agg(c.storage_path), '[]'::jsonb) into v_paths from claimed c;
  return v_paths;
end;
$$;

-- New app code: every bucket, as [{"bucket": ..., "path": ...}].
create or replace function public.claim_orphan_objects(p_limit integer default 500) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_objects jsonb;
begin
  with batch as (
    select o.storage_path from app.orphan_files o
     where (o.claimed_at is null or o.claimed_at < now() - interval '1 hour')
       and app.orphan_claimable(o.bucket, o.storage_path)
     order by o.deleted_at
     limit least(greatest(coalesce(p_limit, 500), 1), 1000)
     for update skip locked
  ), claimed as (
    update app.orphan_files o set claimed_at = now()
      from batch where o.storage_path = batch.storage_path
    returning o.bucket, o.storage_path
  )
  select coalesce(jsonb_agg(jsonb_build_object('bucket', c.bucket, 'path', c.storage_path)), '[]'::jsonb)
    into v_objects from claimed c;
  return v_objects;
end;
$$;

create or replace function app.cleanup_files() returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_url text := coalesce(
    (select s.value from app.settings s where s.key = 'files_cleanup_url'),
    replace((select s.value from app.settings s where s.key = 'push_dispatch_url'), '/api/push/dispatch', '/api/files/cleanup'));
  v_secret text := (select s.value from app.settings s where s.key = 'push_dispatch_secret');
begin
  if v_url is null or v_secret is null
     or not exists (select 1 from pg_extension where extname = 'pg_net')
     or not exists (select 1 from app.orphan_files o where app.orphan_claimable(o.bucket, o.storage_path)) then
    return false;
  end if;
  execute 'select net.http_post(url := $1, body := ''{}''::jsonb, headers := $2)'
    using v_url, jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret);
  return true;
end;
$$;

revoke all on function public.claim_orphan_files(integer) from public, anon, authenticated;
revoke all on function public.claim_orphan_objects(integer) from public, anon, authenticated;
grant execute on function public.claim_orphan_files(integer) to service_role;
grant execute on function public.claim_orphan_objects(integer) to service_role;
revoke all on function app.cleanup_files() from public, anon, authenticated;
