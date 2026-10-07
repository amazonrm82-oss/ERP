-- =============================================================================
-- 0021 Removing stored files of deleted rows
-- =============================================================================
-- A file row deleted with its record (a purge, the nightly cleanup, a merge that
-- deletes) leaves its object in Storage; its path waits in app.orphan_files.
-- Objects can be deleted only through the Storage API, so:
-- * app.cleanup_files(): pg_cron 'crm-file-cleanup' at 03:00 UTC (after the trash
--   purge) wakes the app at /api/files/cleanup through pg_net, with the same shared
--   secret as the push dispatcher. The URL is app.settings 'files_cleanup_url', or
--   derived from 'push_dispatch_url' when that is not set.
-- * public.claim_orphan_files(): the app (service role) takes a batch of paths;
--   public.finish_orphan_files(): it reports the ones it deleted. A path that was
--   claimed but not finished is offered again an hour later.
-- Every statement is safe to run twice.

alter table app.orphan_files add column if not exists claimed_at timestamptz;

create or replace function public.claim_orphan_files(p_limit integer default 500) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_paths jsonb;
begin
  with batch as (
    select o.storage_path from app.orphan_files o
     where o.claimed_at is null or o.claimed_at < now() - interval '1 hour'
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

create or replace function public.finish_orphan_files(p_paths text[]) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from app.orphan_files o where o.storage_path = any (coalesce(p_paths, '{}'));
  get diagnostics v_count = row_count;
  return v_count;
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
     or not exists (select 1 from app.orphan_files) then
    return false;
  end if;
  execute 'select net.http_post(url := $1, body := ''{}''::jsonb, headers := $2)'
    using v_url, jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret);
  return true;
end;
$$;

revoke all on function public.claim_orphan_files(integer) from public, anon, authenticated;
revoke all on function public.finish_orphan_files(text[]) from public, anon, authenticated;
grant execute on function public.claim_orphan_files(integer) to service_role;
grant execute on function public.finish_orphan_files(text[]) to service_role;
revoke all on function app.cleanup_files() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-file-cleanup', '0 3 * * *', 'select app.cleanup_files();');
  end if;
end;
$$;
