-- =============================================================================
-- IMP-04: imports and the full export in the background, through the OPS-04 queue
-- =============================================================================
-- Owner's answer (155) א, 9 November 2026 (DECISIONS.md): two more job kinds, 'import.run' and 'export.run', under
-- answer (55)'s conditions: the queue holds ids and codes only, the functions on the worker's path are pinned by md5
-- (test 309), and the work is done with the rights of the user who ordered it, never as an admin, so every rule of the
-- browser import holds; the files sit in a private bucket under the business's folder for 7 days and then go to the
-- nightly cleanup; a download is a one-minute signed link; undoing a background import works as today.
--
-- * public.background_requests: one order of a background import or full export. A person inserts their own (the
--   rights of the work itself: app.can_import for an import, the owner for the full export; at most 3 open per person
--   and business); every other column is server-kept (trigger background_requests_new): the person, the state, the
--   path of the uploaded file, and the session it was ordered from (its id and aal). Nobody updates or deletes a row
--   through the API; the person submits (public.background_request_submit) and cancels (public.background_request_cancel).
-- * The queue (app.jobs) holds only {request_id, user_id} (app.job_payload_ok).
-- * "As the user" (owner (160) א): the worker never writes a record. Before EVERY signing of a token,
--   public.background_job_token (service_role only, live lease) checks the ordering user again (app.background_refusal):
--   still an active member, the ordering session still in auth.sessions ((161) א; none recorded = refused), and the right
--   of the work (app.can_import / the owner) judged with the user's own claims. It logs the signing in app.platform_log
--   ('background.token', ids only) and answers the claims: sub, role authenticated, the ORIGINAL session's aal and id, and
--   crm_background = the order. The worker signs a 10-minute token with SUPABASE_JWT_SECRET (one file,
--   src/features/background/user-token.ts) and runs the SAME code as the browser path, through PostgREST and Storage, so
--   RLS, column grants, triggers, import_find_duplicates, import_record_consents, import_record_notes, opening_balance_set
--   and log_export judge every write exactly as for the browser; trigger audit_log_background stamps the audit entries.
--   Without the secret no handler is registered and the jobs wait in the queue.
-- * public.background_job_progress / background_job_end (service_role only, live lease only): progress (rows done,
--   counts, the import job the user's own session made), the end, and one `system` notice to the person
--   (entity 'background_request'), with the export's file for 7 days.
-- * Bucket 'job-files' (private): '<org>/<request>/source.json' (the parsed rows the browser uploads, own request
--   waiting for its file) and '<org>/<request>/<uuid>.zip' (the export, written by the worker with the user's token
--   while the request runs). Read: the import's file by its person while it runs; the export by its person while
--   they are the owner and the file has not expired (the signed link is made with the user's session).
-- * app.background_requests_sweep() (pg_cron 'crm-background-requests', every 15 minutes): a request whose queue job
--   ended without its end fails with a notice; a file never uploaded in a day is cancelled; a request not started in 7
--   days fails; 7 days after the order (and after the export's own 7 days) every object of the request's folder goes to
--   app.orphan_files with bucket 'job-files', and the nightly cleanup removes it (CLEANUP_BUCKETS). A deleted request
--   (the business's cascade) queues its folder too.
-- No row is deleted here. Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- The two kinds
-- ----------------------------------------------------------------------------
create or replace function app.job_kinds() returns text[]
language sql immutable
set search_path = ''
as $$ select array['message.send', 'import.run', 'export.run']::text[] $$;
revoke all on function app.job_kinds() from public, anon, authenticated;

insert into app.job_kind_seen (kind) select k from unnest(app.job_kinds()) k on conflict (kind) do nothing;

-- 021177's body, plus the two background kinds: exactly {request_id, user_id}, lower-case uuids
create or replace function app.job_payload_ok(p_kind text, p_payload jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when p_payload is null or jsonb_typeof(p_payload) <> 'object' then false
    when p_kind = 'message.send' then
      coalesce(
        (select bool_and(k in ('channel', 'lead_id', 'contact_id', 'event_at', 'message_type', 'template_id', 'punch_card_id'))
           from jsonb_object_keys(p_payload) k), false)
      and jsonb_typeof(p_payload -> 'channel') = 'string'
      and (p_payload ->> 'channel') in ('email', 'sms', 'whatsapp')
      and ((p_payload ? 'lead_id') <> (p_payload ? 'contact_id'))
      and jsonb_typeof(coalesce(p_payload -> 'lead_id', p_payload -> 'contact_id')) = 'string'
      and coalesce(p_payload ->> 'lead_id', p_payload ->> 'contact_id')
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      -- CNS-07: the message's type, from the closed list (enqueue_job requires it; a job queued before 021147 has none and is
      -- judged as marketing)
      and (not (p_payload ? 'message_type')
           or (jsonb_typeof(p_payload -> 'message_type') = 'string'
               and (p_payload ->> 'message_type') = any (app.message_types())))
      -- MSG-02 (103): the template the message is made from, so a refusal names it
      and (not (p_payload ? 'template_id')
           or (jsonb_typeof(p_payload -> 'template_id') = 'string'
               and (p_payload ->> 'template_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
      -- PKG-03: the punch card a punch_card_notice is about (the sender fills its name, entries and date)
      and (not (p_payload ? 'punch_card_id')
           or (jsonb_typeof(p_payload -> 'punch_card_id') = 'string'
               and (p_payload ->> 'punch_card_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
      and (not (p_payload ? 'event_at')
           or (jsonb_typeof(p_payload -> 'event_at') = 'string'
               and (p_payload ->> 'event_at')
                   ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$'))
    -- IMP-04 (owner (155) א): the order and the person who made it, nothing else
    -- (never null: a missing key is false, not unknown, so the check constraint and enqueue_job refuse it)
    when p_kind in ('import.run', 'export.run') then
      coalesce(
        coalesce((select bool_and(k in ('request_id', 'user_id')) from jsonb_object_keys(p_payload) k), false)
        and jsonb_typeof(p_payload -> 'request_id') = 'string'
        and jsonb_typeof(p_payload -> 'user_id') = 'string'
        and (p_payload ->> 'request_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and (p_payload ->> 'user_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
        false)
    else false
  end
$$;
revoke all on function app.job_payload_ok(text, jsonb) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The orders
-- ----------------------------------------------------------------------------
create table if not exists public.background_requests (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  kind                text not null constraint background_requests_kind_check check (kind in ('import', 'export')),
  created_by          uuid not null,
  status              text not null default 'awaiting_file'
                      constraint background_requests_status_check
                      check (status in ('awaiting_file', 'queued', 'running', 'done', 'failed', 'cancelled')),
  entity_type         text constraint background_requests_entity_check
                      check (entity_type is null or entity_type in ('lead', 'contact', 'company', 'product', 'deal', 'task')),
  file_name           text constraint background_requests_file_name_check
                      check (file_name is null or char_length(file_name) between 1 and 255),
  total_rows          integer constraint background_requests_total_rows_check
                      check (total_rows is null or total_rows between 1 and 50000),
  -- owner (163) ב: a background import only skips or updates duplicates, never "create"
  duplicate_mode      text constraint background_requests_mode_check
                      check (duplicate_mode is null or duplicate_mode in ('skip', 'update')),
  import_job_id       uuid,
  rows_done           integer not null default 0 constraint background_requests_rows_done_check check (rows_done >= 0),
  counts              jsonb not null default '{}'::jsonb,
  result_message      text constraint background_requests_message_check
                      check (result_message is null or char_length(result_message) <= 300),
  source_path         text,
  file_path           text,
  file_expires_at     timestamptz,
  files_cleared_at    timestamptz,
  ordered_aal         text,
  ordered_session_id  uuid,
  queue_job_id        uuid,
  started_at          timestamptz,
  finished_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (organization_id, id),
  constraint background_requests_shape check (
    (kind = 'import' and entity_type is not null and file_name is not null and total_rows is not null and duplicate_mode is not null)
    or (kind = 'export' and entity_type is null and total_rows is null and duplicate_mode is null)),
  foreign key (organization_id, created_by) references public.memberships (organization_id, user_id) on delete cascade,
  foreign key (organization_id, import_job_id) references public.import_jobs (organization_id, id) on delete set null (import_job_id)
);

comment on table public.background_requests is
  'IMP-04: a background import or full export ordered by a person; run by the OPS-04 worker with that person''s own rights.';

create index if not exists background_requests_user_idx on public.background_requests (organization_id, created_by, created_at desc);
create index if not exists background_requests_import_job_idx on public.background_requests (organization_id, import_job_id);
create index if not exists background_requests_open_idx on public.background_requests (status, created_at)
  where files_cleared_at is null;

create or replace trigger background_requests_touch before update on public.background_requests
  for each row execute function app.touch_row();

alter table public.background_requests enable row level security;
revoke all on public.background_requests from anon, authenticated;
grant select on public.background_requests to authenticated;
grant insert (organization_id, kind, entity_type, file_name, total_rows, duplicate_mode) on public.background_requests to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'background_requests'
                  and policyname = 'background_requests_select') then
    create policy background_requests_select on public.background_requests for select to authenticated
      using (created_by = (select auth.uid()) and app.role_in(organization_id) is not null);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'background_requests'
                  and policyname = 'background_requests_insert') then
    create policy background_requests_insert on public.background_requests for insert to authenticated
      with check (created_by = (select auth.uid())
                  and ((kind = 'import' and app.can_import(organization_id))
                       or (kind = 'export' and coalesce(app.membership_role(organization_id)::text = 'owner', false))));
  end if;
end;
$$;

-- what the server keeps on a new order: the person, the state, the file's path and the ordering session; at most 3 open
-- orders per person and business. Invoker: it reads only the session's claims and the person's own rows.
create or replace function app.background_requests_new() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_claims jsonb := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
  v_open integer;
begin
  new.created_by := auth.uid();
  if new.created_by is null then
    raise exception 'a background job is ordered by a signed-in person' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('background_requests:' || new.organization_id::text || ':' || new.created_by::text));
  select count(*) into v_open from public.background_requests r
   where r.organization_id = new.organization_id and r.created_by = new.created_by
     and r.status in ('awaiting_file', 'queued', 'running');
  if v_open >= 3 then
    raise exception 'too many background jobs are open' using errcode = 'P0001', hint = 'background:busy';
  end if;
  new.status := case when new.kind = 'import' then 'awaiting_file' else 'queued' end;
  new.source_path := case when new.kind = 'import' then new.organization_id::text || '/' || new.id::text || '/source.json' end;
  new.file_name := case when new.kind = 'import' then btrim(new.file_name) end;
  new.import_job_id := null;
  new.rows_done := 0;
  new.counts := '{}'::jsonb;
  new.result_message := null;
  new.file_path := null;
  new.file_expires_at := null;
  new.files_cleared_at := null;
  new.queue_job_id := null;
  new.started_at := null;
  new.finished_at := null;
  new.created_at := now();
  new.ordered_aal := case when v_claims ->> 'aal' in ('aal1', 'aal2') then v_claims ->> 'aal' end;
  new.ordered_session_id := case when (v_claims ->> 'session_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                 then (v_claims ->> 'session_id')::uuid end;
  return new;
end;
$$;
revoke all on function app.background_requests_new() from public, anon, authenticated;

create or replace trigger background_requests_new before insert on public.background_requests
  for each row execute function app.background_requests_new();

-- the export goes to the queue at once (the import waits for its file: public.background_request_submit)
create or replace function app.background_requests_enqueue() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_job uuid;
begin
  if new.kind = 'export' and new.status = 'queued' then
    v_job := app.enqueue_job(new.organization_id, 'export.run',
                             jsonb_build_object('request_id', new.id::text, 'user_id', new.created_by::text));
    update public.background_requests r set queue_job_id = v_job where r.id = new.id;
  end if;
  return null;
end;
$$;
revoke all on function app.background_requests_enqueue() from public, anon, authenticated;

create or replace trigger background_requests_enqueue after insert on public.background_requests
  for each row execute function app.background_requests_enqueue();

-- ----------------------------------------------------------------------------
-- The files: private bucket 'job-files'
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('job-files', 'job-files', false, null, array['application/json', 'application/zip'])
on conflict (id) do update set public = false, allowed_mime_types = array['application/json', 'application/zip'];

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'job_files_select') then
    create policy job_files_select on storage.objects for select to authenticated
      using (bucket_id = 'job-files'
             and exists (select 1 from public.background_requests r
                          where r.created_by = (select auth.uid())
                            and ((r.kind = 'import' and r.status = 'running' and objects.name = r.source_path
                                  and app.can_import(r.organization_id)
                                  -- review 4: only the worker's token of this order reads the uploaded rows
                                  and (select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'crm_background') = r.id::text)
                                 or (r.kind = 'export' and r.status = 'done' and objects.name = r.file_path
                                     and r.file_expires_at > now()
                                     and coalesce(app.membership_role(r.organization_id)::text = 'owner', false)))));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'job_files_insert') then
    create policy job_files_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'job-files'
                  and exists (select 1 from public.background_requests r
                               where r.created_by = (select auth.uid())
                                 and ((r.kind = 'import' and r.status = 'awaiting_file' and objects.name = r.source_path
                                       and app.can_import(r.organization_id))
                                      or (r.kind = 'export' and r.status = 'running'
                                          and split_part(objects.name, '/', 1) = r.organization_id::text
                                          and split_part(objects.name, '/', 2) = r.id::text
                                          and objects.name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]zip$'
                                          and coalesce(app.membership_role(r.organization_id)::text = 'owner', false)
                                          -- review 4: only the worker's token of this order writes the export
                                          and (select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'crm_background')
                                              = r.id::text))));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- Cleanup: the queue takes 'job-files'
-- ----------------------------------------------------------------------------
alter table app.orphan_files drop constraint if exists orphan_files_bucket_check;
alter table app.orphan_files add constraint orphan_files_bucket_check check (bucket in ('record-files', 'avatars', 'org-logos', 'job-files'));

-- 019920's body, plus: a background file is claimed only when no order holds its path any more
create or replace function app.orphan_claimable(p_bucket text, p_path text) returns boolean
language sql stable
set search_path = ''
as $$
  select p_bucket = 'record-files'
      or (p_bucket = 'avatars' and not exists (select 1 from public.profiles p where p.avatar_url = p_path))
      or (p_bucket = 'org-logos' and app.org_logo_org(p_path) is not null
          and not exists (select 1 from public.organizations o where o.logo_path = p_path))
      or (p_bucket = 'job-files'
          and not exists (select 1 from public.background_requests r where r.source_path = p_path or r.file_path = p_path))
$$;
revoke all on function app.orphan_claimable(text, text) from public, anon, authenticated;

-- every object of an order's folder, and its known paths, into the cleanup queue
create or replace function app.background_files_queue(p_org uuid, p_request uuid, p_source text, p_file text) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into app.orphan_files (storage_path, bucket)
  select p, 'job-files' from unnest(array[p_source, p_file]) p where p is not null
  on conflict do nothing;
  -- needs the function owner to bypass the storage RLS policies (role postgres on Supabase), as profiles_avatar_orphans
  begin
    insert into app.orphan_files (storage_path, bucket)
    select o.name, 'job-files' from storage.objects o
     where o.bucket_id = 'job-files' and o.name like p_org::text || '/' || p_request::text || '/%'
    on conflict do nothing;
  exception when insufficient_privilege then
    raise warning 'background_files_queue: cannot read storage.objects; only the known paths of request % were queued', p_request;
  end;
end;
$$;
revoke all on function app.background_files_queue(uuid, uuid, text, text) from public, anon, authenticated;

create or replace function app.background_requests_deleted() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform app.background_files_queue(old.organization_id, old.id, old.source_path, old.file_path);
  return old;
end;
$$;
revoke all on function app.background_requests_deleted() from public, anon, authenticated;

create or replace trigger background_requests_deleted after delete on public.background_requests
  for each row execute function app.background_requests_deleted();

-- ----------------------------------------------------------------------------
-- Notices
-- ----------------------------------------------------------------------------
create or replace function app.background_notify(p_request public.background_requests) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_title text;
  v_body text;
  v_counts jsonb := coalesce(p_request.counts, '{}'::jsonb);
begin
  if not exists (select 1 from public.memberships m
                  where m.organization_id = p_request.organization_id and m.user_id = p_request.created_by and m.status = 'active') then
    return;
  end if;
  if p_request.kind = 'import' and p_request.status = 'done' then
    v_title := 'הייבוא ברקע הסתיים';
    v_body := p_request.file_name || ': נוצרו ' || coalesce(v_counts ->> 'created', '0') || ', עודכנו '
              || coalesce(v_counts ->> 'updated', '0') || ', דולגו ' || coalesce(v_counts ->> 'skipped', '0')
              || ', נכשלו ' || coalesce(v_counts ->> 'failed', '0') || '.';
  elsif p_request.kind = 'import' then
    v_title := 'הייבוא ברקע נעצר';
    v_body := p_request.file_name || ': ' || coalesce(p_request.result_message, 'לא הצלחנו להשלים את הייבוא.');
  elsif p_request.status = 'done' then
    v_title := 'הייצוא המלא מוכן להורדה';
    v_body := 'הקובץ נשמר 7 ימים. אפשר להוריד אותו מעמוד הייבוא והייצוא.';
  else
    v_title := 'הייצוא המלא לא הושלם';
    v_body := coalesce(p_request.result_message, 'אפשר לנסות שוב, או להוריד את הייצוא ישירות מעמוד הייבוא והייצוא.');
  end if;
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  values (p_request.organization_id, p_request.created_by, 'system', v_title, left(v_body, 500), 'background_request', p_request.id);
end;
$$;
revoke all on function app.background_notify(public.background_requests) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The person: submit the uploaded file, cancel
-- ----------------------------------------------------------------------------
create or replace function public.background_request_submit(p_org uuid, p_request uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_req public.background_requests%rowtype;
  v_has_file boolean;
  v_job uuid;
begin
  select * into v_req from public.background_requests r
   where r.organization_id = p_org and r.id = p_request for update;
  if not found or v_req.created_by is distinct from auth.uid() then
    raise exception 'not found' using errcode = '42501';
  end if;
  if v_req.kind <> 'import' or v_req.status <> 'awaiting_file' then
    raise exception 'the request is not waiting for its file' using errcode = 'P0001', hint = 'background:state';
  end if;
  if not app.can_import(p_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  begin
    v_has_file := exists (select 1 from storage.objects o where o.bucket_id = 'job-files' and o.name = v_req.source_path);
  exception when insufficient_privilege then
    -- the worker's download fails without the file, and the request then ends with a notice
    v_has_file := true;
  end;
  if not v_has_file then
    raise exception 'the file did not arrive' using errcode = 'P0001', hint = 'background:no_file';
  end if;
  v_job := app.enqueue_job(p_org, 'import.run', jsonb_build_object('request_id', v_req.id::text, 'user_id', v_req.created_by::text));
  update public.background_requests r set status = 'queued', queue_job_id = v_job where r.id = v_req.id;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.background_request_submit(uuid, uuid) from public, anon;
grant execute on function public.background_request_submit(uuid, uuid) to authenticated;

create or replace function public.background_request_cancel(p_org uuid, p_request uuid) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  update public.background_requests r
     set status = 'cancelled', finished_at = now(), result_message = 'בוטל לבקשתכם.'
   where r.organization_id = p_org and r.id = p_request and r.created_by = auth.uid()
     and r.status in ('awaiting_file', 'queued', 'running')
  returning r.id into v_id;
  return v_id is not null;
end;
$$;
revoke all on function public.background_request_cancel(uuid, uuid) from public, anon;
grant execute on function public.background_request_cancel(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The worker's three calls (service_role only, live lease only)
-- ----------------------------------------------------------------------------
-- review 3: the ordering session as it is now: null when it is gone, belongs to someone else, has run out (not_after), or
-- cannot be read (fail closed); else the lower of the order's aal and the session's current aal, so a session lowered
-- since the order counts at its lower level. Reads auth.sessions as the function owner (postgres, the migration owner,
-- which reads it on Supabase).
create or replace function app.background_session_aal(p_request public.background_requests) returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_aal text;
  v_found boolean := false;
begin
  if p_request.ordered_session_id is null then
    return null;
  end if;
  begin
    select true, s.aal::text into v_found, v_aal
      from auth.sessions s
     where s.id = p_request.ordered_session_id and s.user_id = p_request.created_by
       and (s.not_after is null or s.not_after > now());
  exception when others then
    return null;
  end;
  if not coalesce(v_found, false) then
    return null;
  end if;
  return least(coalesce(p_request.ordered_aal, 'aal1'), case when v_aal in ('aal1', 'aal2') then v_aal else 'aal1' end);
end;
$$;
revoke all on function app.background_session_aal(public.background_requests) from public, anon, authenticated, service_role;

-- the claims the worker's token carries, and the claims every check below runs under: the ordering person, role
-- authenticated, the aal of the ordering session (the lower of the order's and the session's now; never more)
create or replace function app.background_claims(p_request public.background_requests) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'sub', p_request.created_by::text,
    'role', 'authenticated',
    'aal', coalesce(app.background_session_aal(p_request), 'aal1'),
    'session_id', p_request.ordered_session_id::text,
    'crm_background', p_request.id::text))
$$;
revoke all on function app.background_claims(public.background_requests) from public, anon, authenticated;

-- the lease is live and the job is a background one; the row, locked
create or replace function app.background_job_row(p_job uuid, p_lease uuid) returns app.jobs
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs%rowtype;
begin
  select * into v_job from app.jobs j where j.id = p_job for update;
  if not found or v_job.kind not in ('import.run', 'export.run') or v_job.status <> 'running'
     or p_lease is null or v_job.lease_id is distinct from p_lease or not (v_job.locked_until > now()) then
    return null;
  end if;
  return v_job;
end;
$$;
revoke all on function app.background_job_row(uuid, uuid) from public, anon, authenticated, service_role;

-- may the person still do this work? Judged with the person's own claims (app.can_import / the owner), then the
-- caller's claims are put back
create or replace function app.background_allowed(p_request public.background_requests) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_saved text := current_setting('request.jwt.claims', true);
  v_ok boolean;
begin
  perform set_config('request.jwt.claims', app.background_claims(p_request)::text, true);
  begin
    v_ok := case p_request.kind
              when 'import' then app.can_import(p_request.organization_id)
              else coalesce(app.membership_role(p_request.organization_id)::text = 'owner', false)
            end;
  exception when others then
    perform set_config('request.jwt.claims', coalesce(v_saved, ''), true);
    raise;
  end;
  perform set_config('request.jwt.claims', coalesce(v_saved, ''), true);
  return coalesce(v_ok, false);
end;
$$;
revoke all on function app.background_allowed(public.background_requests) from public, anon, authenticated, service_role;

-- why the person may not go on (null = they may): still an active member, the ordering session still open (owner (161) א;
-- an order without a session id is refused, fail closed), and the right of the work judged with their own claims
-- review 5: the legal-agreement gate of requireAgreement(), in the job. The current version lives in the app
-- (LEGAL_VERSION); the worker hands it in, and the database accepts it only when it is a version it registered texts for
-- (app.agreement_texts, FXS-09), else 'agreement' (fail closed). The person's latest signature must be of that version,
-- read the way public.agreement_status() reads it.
create or replace function app.background_refusal(p_request public.background_requests, p_legal_version text) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.memberships m
                  where m.organization_id = p_request.organization_id and m.user_id = p_request.created_by and m.status = 'active') then
    return 'not_member';
  end if;
  if app.background_session_aal(p_request) is null then
    return 'session_ended';
  end if;
  if p_legal_version is null
     or not exists (select 1 from app.agreement_texts t where t.version = p_legal_version)
     or (select s.version from app.agreement_signatures s where s.user_id = p_request.created_by
          order by s.signed_at desc limit 1) is distinct from p_legal_version then
    return 'agreement';
  end if;
  if not app.background_allowed(p_request) then
    return 'not_allowed';
  end if;
  return null;
end;
$$;
revoke all on function app.background_refusal(public.background_requests, text) from public, anon, authenticated, service_role;

-- ends the job (refused) and, with a reason the person should hear, the order with a notice
create or replace function app.background_refuse(p_job uuid, p_request public.background_requests, p_reason text) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_req public.background_requests%rowtype;
  v_message text := case p_reason
    when 'not_member' then 'העבודה בוטלה: מי שהזמין אותה כבר לא חבר פעיל בעסק.'
    when 'session_ended' then 'העבודה בוטלה כי יצאתם מהחשבון במכשיר שממנו הזמנתם אותה. אפשר להזמין אותה שוב.'
    when 'not_allowed' then 'העבודה בוטלה: כבר אין לכם הרשאה לבצע אותה.'
    when 'agreement' then 'העבודה נעצרה כי צריך לאשר את תנאי השימוש המעודכנים. אחרי האישור אפשר להזמין אותה שוב.'
  end;
begin
  update app.jobs j set status = 'refused', lease_id = null, locked_until = null, finished_at = now(),
                        last_error = 'refused:' || p_reason
   where j.id = p_job;
  if v_message is not null and p_request.id is not null and p_request.status in ('queued', 'running') then
    update public.background_requests r set status = 'failed', finished_at = now(), result_message = v_message
     where r.id = p_request.id
    returning * into v_req;
    perform app.background_notify(v_req);
  end if;
end;
$$;
revoke all on function app.background_refuse(uuid, public.background_requests, text) from public, anon, authenticated, service_role;

-- the order of a live background lease, locked; null fields when the lease or the order does not hold
create or replace function app.background_request_of(p_job app.jobs) returns public.background_requests
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_req public.background_requests%rowtype;
begin
  select * into v_req from public.background_requests r
   where r.organization_id = p_job.organization_id and r.id = (p_job.payload ->> 'request_id')::uuid
     and r.created_by = (p_job.payload ->> 'user_id')::uuid and r.queue_job_id = p_job.id
     and r.kind = (case p_job.kind when 'import.run' then 'import' else 'export' end)
   for update;
  return v_req;
end;
$$;
revoke all on function app.background_request_of(app.jobs) from public, anon, authenticated, service_role;

-- begin: the order starts (or goes on) running; answers what the work needs, never the claims (those come only from
-- background_job_token, which checks again before every signing)
create or replace function public.background_job_begin(p_job uuid, p_lease uuid, p_legal_version text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_req public.background_requests;
  v_reason text;
begin
  v_job := app.background_job_row(p_job, p_lease);
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'reason', 'stale');
  end if;
  v_req := app.background_request_of(v_job);
  if v_req.id is null then
    v_reason := 'request_gone';
  elsif v_req.status not in ('queued', 'running') then
    v_reason := 'request_closed';
  else
    v_reason := app.background_refusal(v_req, p_legal_version);
  end if;
  if v_reason is not null then
    perform app.background_refuse(v_job.id, v_req, v_reason);
    return jsonb_build_object('ok', false, 'reason', v_reason);
  end if;
  update public.background_requests r set status = 'running', started_at = coalesce(r.started_at, now())
   where r.id = v_req.id;
  return jsonb_build_object(
    'ok', true, 'kind', v_req.kind, 'request_id', v_req.id, 'duplicate_mode', v_req.duplicate_mode,
    'import_job_id', v_req.import_job_id, 'rows_done', v_req.rows_done, 'counts', v_req.counts,
    'source_path', v_req.source_path);
end;
$$;
revoke all on function public.background_job_begin(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.background_job_begin(uuid, uuid, text) to service_role;

-- owner (160) א: the ONLY source of the claims the worker signs. Before every signing (the first and every refresh) it
-- checks the lease, a running order, and app.background_refusal; it logs the signing in app.platform_log (ids only) and
-- answers the person's claims: sub, role authenticated, the ordering session's aal and id, crm_background = the order,
-- and the lease's end (locked_until; the token's exp is never later). The worker hands in the app's LEGAL_VERSION.
create or replace function public.background_job_token(p_job uuid, p_lease uuid, p_legal_version text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_req public.background_requests;
  v_reason text;
begin
  v_job := app.background_job_row(p_job, p_lease);
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'reason', 'stale');
  end if;
  v_req := app.background_request_of(v_job);
  if v_req.id is null then
    v_reason := 'request_gone';
  elsif v_req.status <> 'running' then
    v_reason := 'request_closed';
  else
    v_reason := app.background_refusal(v_req, p_legal_version);
  end if;
  if v_reason is not null then
    perform app.background_refuse(v_job.id, v_req, v_reason);
    return jsonb_build_object('ok', false, 'reason', v_reason);
  end if;
  insert into app.platform_log (actor_id, action, organization_id, details)
  values (null, 'background.token', v_req.organization_id,
          jsonb_build_object('request_id', v_req.id, 'user_id', v_req.created_by, 'session_id', v_req.ordered_session_id,
                             'job_id', v_job.id));
  -- review 2: the lease's end, so the signed token never outlives it
  return jsonb_build_object('ok', true, 'claims', app.background_claims(v_req), 'locked_until', v_job.locked_until);
end;
$$;
revoke all on function public.background_job_token(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.background_job_token(uuid, uuid, text) to service_role;

-- ----------------------------------------------------------------------------
-- The audit says "through a background job" (owner (160) א)
-- ----------------------------------------------------------------------------
-- Every audit entry written under the worker's token of the person (app.audit_row and every function that inserts into
-- audit_log itself, log_export included) carries changes.background = {request_id}, a plain value (never an {old, new}
-- pair, so lists show it as context). The claim counts only when it names a RUNNING order of this business made by the
-- entry's own actor (auth.uid()); a token without it, or with any other value, stamps nothing. A delete's entry keeps the
-- row as it was (its snapshot is read back by restores and the retention rule) and is not stamped; the platform log keeps
-- every signing. app.audit_row is not redefined.
create or replace function app.audit_log_background() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_claim text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'crm_background';
begin
  if v_claim is null or new.action = 'delete' or new.actor_id is null
     or v_claim !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return new;
  end if;
  if exists (select 1 from public.background_requests r
              where r.id = v_claim::uuid and r.organization_id = new.organization_id
                and r.created_by = new.actor_id and new.actor_id = auth.uid() and r.status = 'running') then
    new.changes := coalesce(new.changes, '{}'::jsonb) || jsonb_build_object('background', jsonb_build_object('request_id', v_claim));
  end if;
  return new;
end;
$$;
revoke all on function app.audit_log_background() from public, anon, authenticated;

create or replace trigger audit_log_background before insert on public.audit_log
  for each row execute function app.audit_log_background();

-- counts are whole numbers 0..50,000 under known keys
create or replace function app.background_counts_ok(p_counts jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_counts is not null and jsonb_typeof(p_counts) = 'object'
     and coalesce((select bool_and(k in ('created', 'updated', 'skipped', 'failed', 'rows')
                                   and jsonb_typeof(p_counts -> k) = 'number'
                                   and (p_counts ->> k) ~ '^[0-9]{1,9}$'
                                   and (p_counts ->> k)::integer <= 10000000)
                     from jsonb_object_keys(p_counts) k), true)
$$;
revoke all on function app.background_counts_ok(jsonb) from public, anon, authenticated;

create or replace function public.background_job_progress(p_job uuid, p_lease uuid, p_rows_done integer, p_counts jsonb,
                                                          p_import_job uuid default null) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_req public.background_requests%rowtype;
begin
  v_job := app.background_job_row(p_job, p_lease);
  if v_job.id is null or v_job.kind <> 'import.run' then
    return 'stale';
  end if;
  select * into v_req from public.background_requests r
   where r.organization_id = v_job.organization_id and r.id = (v_job.payload ->> 'request_id')::uuid
   for update;
  if not found or v_req.queue_job_id is distinct from v_job.id then
    return 'stale';
  end if;
  if v_req.status <> 'running' then
    return 'cancelled';
  end if;
  if p_rows_done is null or p_rows_done < v_req.rows_done or p_rows_done > v_req.total_rows
     or not app.background_counts_ok(p_counts) then
    return 'invalid';
  end if;
  -- the import job is the one the person's own session made for this order (never someone else's, never changed)
  if p_import_job is not null and (v_req.import_job_id is distinct from p_import_job) then
    if v_req.import_job_id is not null
       or not exists (select 1 from public.import_jobs i
                       where i.organization_id = v_req.organization_id and i.id = p_import_job
                         and i.created_by = v_req.created_by and i.entity_type = v_req.entity_type) then
      return 'invalid';
    end if;
  end if;
  update public.background_requests r
     set rows_done = p_rows_done, counts = p_counts, import_job_id = coalesce(p_import_job, r.import_job_id)
   where r.id = v_req.id;
  return 'ok';
end;
$$;
revoke all on function public.background_job_progress(uuid, uuid, integer, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.background_job_progress(uuid, uuid, integer, jsonb, uuid) to service_role;

create or replace function public.background_job_end(p_job uuid, p_lease uuid, p_ok boolean, p_counts jsonb default null,
                                                     p_message text default null, p_file_path text default null) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_req public.background_requests%rowtype;
  v_ok boolean := coalesce(p_ok, false);
  v_has_file boolean;
begin
  v_job := app.background_job_row(p_job, p_lease);
  if v_job.id is null then
    return 'stale';
  end if;
  select * into v_req from public.background_requests r
   where r.organization_id = v_job.organization_id and r.id = (v_job.payload ->> 'request_id')::uuid
   for update;
  if not found or v_req.queue_job_id is distinct from v_job.id then
    return 'stale';
  end if;
  if v_req.status <> 'running' then
    return 'cancelled';
  end if;
  if p_counts is not null and not app.background_counts_ok(p_counts) then
    return 'invalid';
  end if;
  if v_req.kind = 'export' and v_ok then
    -- the export's file: in the order's own folder, a fresh uuid, and present
    if p_file_path is null
       or p_file_path !~ ('^' || v_req.organization_id::text || '/' || v_req.id::text
                          || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]zip$') then
      return 'invalid';
    end if;
    begin
      v_has_file := exists (select 1 from storage.objects o where o.bucket_id = 'job-files' and o.name = p_file_path);
    exception when insufficient_privilege then
      v_has_file := true;
    end;
    if not v_has_file then
      return 'invalid';
    end if;
  elsif p_file_path is not null then
    return 'invalid';
  end if;
  update public.background_requests r
     set status = case when v_ok then 'done' else 'failed' end,
         finished_at = now(),
         counts = coalesce(p_counts, r.counts),
         result_message = left(nullif(btrim(coalesce(p_message, '')), ''), 300),
         file_path = case when v_req.kind = 'export' and v_ok then p_file_path end,
         file_expires_at = case when v_req.kind = 'export' and v_ok then now() + interval '7 days' end
   where r.id = v_req.id
  returning * into v_req;
  perform app.background_notify(v_req);
  return 'ended';
end;
$$;
revoke all on function public.background_job_end(uuid, uuid, boolean, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.background_job_end(uuid, uuid, boolean, jsonb, text, text) to service_role;

-- ----------------------------------------------------------------------------
-- The sweep: stuck orders, files never sent, 7 days
-- ----------------------------------------------------------------------------
create or replace function app.background_requests_sweep() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_req public.background_requests%rowtype;
  v_count integer := 0;
begin
  -- an order whose queue job ended without the worker's end (dead after its tries, or refused), or that did not start
  -- in 7 days (no worker configured)
  for v_req in
    select r.* from public.background_requests r
     where r.status in ('queued', 'running')
       and (r.created_at < now() - interval '7 days'
            or not exists (select 1 from app.jobs j where j.id = r.queue_job_id and j.status in ('queued', 'running', 'failed')))
     order by r.created_at
     limit 500
     for update of r skip locked
  loop
    update public.background_requests r
       set status = 'failed', finished_at = now(),
           result_message = case when v_req.created_at < now() - interval '7 days' then 'העבודה לא התחילה תוך 7 ימים.'
                                 -- owner (162) ב: an export that could not be kept points to the direct download
                                 when v_req.kind = 'export'
                                   then 'לא הצלחנו להכין את הקובץ ברקע. אפשר לנסות שוב, או להוריד את הייצוא ישירות מעמוד הייבוא והייצוא.'
                                 else 'לא הצלחנו להשלים את העבודה. אפשר לנסות שוב.' end
     where r.id = v_req.id
    returning * into v_req;
    perform app.background_notify(v_req);
    v_count := v_count + 1;
  end loop;

  -- a file that never arrived within a day
  update public.background_requests r
     set status = 'cancelled', finished_at = now(), result_message = 'הקובץ לא הגיע.'
   where r.status = 'awaiting_file' and r.created_at < now() - interval '1 day';

  -- 7 days after the order, and after the export's own 7 days: the folder goes to the nightly cleanup
  for v_req in
    select r.* from public.background_requests r
     where r.files_cleared_at is null
       and r.status in ('done', 'failed', 'cancelled')
       and r.created_at <= now() - interval '7 days'
       and (r.file_expires_at is null or r.file_expires_at <= now())
     order by r.created_at
     limit 1000
     for update of r skip locked
  loop
    update public.background_requests r set source_path = null, file_path = null, files_cleared_at = now()
     where r.id = v_req.id;
    perform app.background_files_queue(v_req.organization_id, v_req.id, v_req.source_path, v_req.file_path);
  end loop;
  return v_count;
end;
$$;
revoke all on function app.background_requests_sweep() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-background-requests', '*/15 * * * *', 'select app.background_requests_sweep();');
  end if;
end;
$$;

notify pgrst, 'reload schema';
