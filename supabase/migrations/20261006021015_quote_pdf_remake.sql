-- =============================================================================
-- QUO-06 follow-up (owner, 26 October 2026, DECISIONS.md "PDF של הצעת מחיר: המשך", answer 1 (ג)): a stored quote PDF
-- without a fingerprint is made again by the server, once
-- =============================================================================
-- A PDF kept by the old flow (before 020995) has no files.sha256, so the customer's link never serves it. Lazily, when a
-- staff member who may edit the quote opens it or the server is asked to store it again, the app renders the quote and
-- calls public.quote_pdf_store as for a new file; for a confirmed row without a fingerprint that function now hands over to
-- app.quote_pdf_remake:
--   * the first call answers a fresh path `<org>/<uuid>` (kept in app.quote_pdf_remakes, one row per file); the row itself
--     stays as it is and keeps serving the old object meanwhile;
--   * the server uploads there (upsert off) and calls again naming that path; when the object is a PDF of the stated size
--     the same files row moves to the new path with the new SHA-256, and the old path goes to the orphan cleanup
--     (app.quote_pdf_abandon -> app.orphan_files -> crm-file-cleanup): the old file is deleted with no row removed;
--   * not counted in max_pdf_per_month: no files row is inserted, and files_quote_pdf (app.pdf_take) fires on insert only;
--   * once, ever: app.quote_pdf_remakes.done_at marks it (and the row now has a SHA-256, which nothing clears);
--   * the customer's link (public.quote_public_pdf) serves it as soon as it has its SHA-256;
--   * one audit entry per finished remake (action pdf_remake, entity files, sizes only; review L2);
--   * an attempt's path that never becomes the file is always queued for the cleanup (review M1): a takeover, an erased
--     customer or a removed flag, the job removed with its file (trigger quote_pdf_remakes_gone), and a job left for a day
--     (app.quote_pdf_remake_sweep, pg_cron crm-quote-pdf-remake-sweep at 02:40 UTC, marked abandoned_at, nothing deleted);
--   * a render starts at most once a minute per file and never while an attempt is on its way or done
--     (app.quote_pdf_remake_claim, asked through public.quote_pdf_remake_allowed; review L1).
-- The user is checked by public.quote_pdf_store as before (app.quote_pdf_user_may). With the person's own session the app
-- first asks public.quote_pdf_remake_allowed (invoker): a quote that is no longer a draft, whose customer is not erased, in a
-- writable business with the `quotes` flag, that the caller may edit, holding a confirmed PDF without a fingerprint. Unlike a
-- new PDF, the quote need not be sent or viewed any more: the file exists already, this only fingerprints it.
--
-- Every statement is safe to run twice. No drops, no row removal.

create table if not exists app.quote_pdf_remakes (
  organization_id uuid not null,
  file_id         uuid not null primary key,
  -- this attempt's own path, SHA-256 and size (a takeover after two minutes replaces them); null until a render starts
  path            text,
  sha256          text check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes      bigint check (size_bytes between 1 and 26214400),
  started_at      timestamptz,
  -- review L1: the last time someone was let through to render (at most one attempt per file a minute)
  last_attempt_at timestamptz,
  -- review M1: the attempt's path was queued for the cleanup because it never finished (the nightly sweep, an erased
  -- customer); a later attempt starts a fresh path
  abandoned_at    timestamptz,
  -- set once the row moved to the new file; never cleared (the marker: made again once, ever)
  done_at         timestamptz,
  old_path        text,
  constraint quote_pdf_remakes_file_fk foreign key (organization_id, file_id)
    references public.files (organization_id, id) on delete cascade
);
create index if not exists quote_pdf_remakes_file_idx on app.quote_pdf_remakes (organization_id, file_id);
create index if not exists quote_pdf_remakes_open_idx on app.quote_pdf_remakes (started_at)
  where done_at is null and abandoned_at is null and path is not null;
alter table app.quote_pdf_remakes enable row level security;
revoke all on app.quote_pdf_remakes from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Review L1: may a render start now? A remake that is done, on its way (two minutes) or tried in the last minute is not
-- rendered again. Lets one caller through per file a minute and stamps last_attempt_at. Answers a boolean only, for a
-- member of the business, about that business's quote PDF without a fingerprint.
-- ----------------------------------------------------------------------------
create or replace function app.quote_pdf_remake_claim(p_org uuid, p_file uuid) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.quote_pdf_remakes;
begin
  if p_org is null or p_file is null or not app.is_member(p_org) then
    return false;
  end if;
  if not exists (select 1 from public.files f
                  where f.organization_id = p_org and f.id = p_file and f.quote_id is not null
                    and f.unconfirmed_since is null and f.sha256 is null) then
    return false;
  end if;
  insert into app.quote_pdf_remakes (organization_id, file_id) values (p_org, p_file) on conflict (file_id) do nothing;
  select * into v_job from app.quote_pdf_remakes r where r.file_id = p_file for update;
  if v_job.done_at is not null
     or (v_job.path is not null and v_job.abandoned_at is null and v_job.started_at > now() - interval '2 minutes')
     or v_job.last_attempt_at > now() - interval '1 minute' then
    return false;
  end if;
  update app.quote_pdf_remakes r set last_attempt_at = now() where r.file_id = p_file;
  return true;
end;
$$;
revoke all on function app.quote_pdf_remake_claim(uuid, uuid) from public, anon, service_role;
grant execute on function app.quote_pdf_remake_claim(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The person's right, asked with their own session before the app renders (review L1 of 020995: aal2 holds here); true
-- only when a render should start now (app.quote_pdf_remake_claim)
-- ----------------------------------------------------------------------------
create or replace function public.quote_pdf_remake_allowed(p_org uuid, p_quote uuid) returns boolean
language plpgsql volatile security invoker
set search_path = ''
as $$
declare
  v_file uuid;
begin
  select f.id into v_file
    from public.quotes q
    join public.files f on f.organization_id = q.organization_id and f.quote_id = q.id
   where q.organization_id = p_org and q.id = p_quote
     and q.status <> 'draft'
     and q.customer_deleted_at is null
     and f.unconfirmed_since is null and f.sha256 is null
     and app.can_write(q.organization_id)
     and app.org_writable(q.organization_id)
     and app.org_has_feature(q.organization_id, 'quotes')
     and app.quote_editable(q.organization_id, q.deal_id, q.contact_id);
  if v_file is null then
    return false;
  end if;
  return app.quote_pdf_remake_claim(p_org, v_file);
end;
$$;
revoke all on function public.quote_pdf_remake_allowed(uuid, uuid) from public, anon;
grant execute on function public.quote_pdf_remake_allowed(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The remake itself (called only by public.quote_pdf_store, under its advisory lock and with the row locked FOR UPDATE).
-- Answers like quote_pdf_store: {status: upload, path}, {status: stored, file_id} or {status: busy}.
-- ----------------------------------------------------------------------------
create or replace function app.quote_pdf_remake(p_quote public.quotes, p_file public.files, p_user uuid, p_size bigint,
                                                p_sha256 text, p_name text, p_path text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_org  uuid := p_file.organization_id;
  v_job  app.quote_pdf_remakes;
  v_obj  record;
  v_path text;
  v_open boolean;
begin
  select * into v_job from app.quote_pdf_remakes r where r.file_id = p_file.id for update;
  -- an attempt whose upload may still be on its way (or already there) under its own path
  v_open := v_job.path is not null and v_job.done_at is null and v_job.abandoned_at is null;

  -- not made again: a draft (cannot hold one), an erased customer, a business without quotes; the old file stays as it is,
  -- and an open attempt's path is queued for the cleanup (review M1)
  if p_quote.status = 'draft' or p_quote.customer_deleted_at is not null or not app.org_has_feature(v_org, 'quotes') then
    perform app.quote_pdf_abandon(v_org, p_path);
    if v_open then
      perform app.quote_pdf_abandon(v_org, v_job.path);
      update app.quote_pdf_remakes r set abandoned_at = now() where r.file_id = p_file.id;
    end if;
    return jsonb_build_object('status', 'stored', 'file_id', p_file.id);
  end if;

  if v_job.done_at is not null then
    -- once, ever (the row has its SHA-256 by then; this holds even if something cleared it)
    perform app.quote_pdf_abandon(v_org, p_path);
    return jsonb_build_object('status', 'stored', 'file_id', p_file.id);
  end if;

  if v_open and p_path is not null and v_job.path = p_path and v_job.sha256 = p_sha256 and v_job.size_bytes = p_size then
    -- the second call of the attempt that holds the job: its own path must hold a PDF of the stated size
    select * into v_obj from app.record_file_object(p_path);
    if v_obj.present and v_obj.size = v_job.size_bytes and v_obj.mimetype = 'application/pdf' then
      update public.files f
         set storage_path = p_path, sha256 = p_sha256, size_bytes = v_job.size_bytes, name = p_name,
             upload_checked_at = now()
       where f.organization_id = v_org and f.id = p_file.id;
      update app.quote_pdf_remakes r set done_at = now(), old_path = p_file.storage_path where r.file_id = p_file.id;
      -- the old file is deleted: its object goes to the nightly cleanup now that no row uses its path
      perform app.quote_pdf_abandon(v_org, p_file.storage_path);
      -- review L2: one audit entry per finished remake, sizes only (no path, no name)
      insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
      values (v_org, p_user, 'pdf_remake', 'files', p_file.id,
              jsonb_build_object('old_size', p_file.size_bytes, 'new_size', v_job.size_bytes));
      return jsonb_build_object('status', 'stored', 'file_id', p_file.id);
    end if;
    if not v_obj.present then
      return jsonb_build_object('status', 'upload', 'path', p_path);
    end if;
    -- something else is on the attempt's path: leave it to the cleanup and start a fresh path
  else
    -- a stale attempt's own upload is queued for the cleanup
    if p_path is not null and (not v_open or p_path is distinct from v_job.path) then
      perform app.quote_pdf_abandon(v_org, p_path);
    end if;
    -- another attempt holds the job; after two minutes without its object it is taken over
    if v_open and v_job.started_at > now() - interval '2 minutes' then
      return jsonb_build_object('status', 'busy');
    end if;
  end if;

  -- a fresh path for this attempt; the abandoned one goes to the orphan cleanup (no row uses it)
  v_path := v_org::text || '/' || gen_random_uuid()::text;
  insert into app.quote_pdf_remakes as r (organization_id, file_id, path, sha256, size_bytes, started_at)
  values (v_org, p_file.id, v_path, p_sha256, p_size, now())
  on conflict (file_id) do update
    set path = excluded.path, sha256 = excluded.sha256, size_bytes = excluded.size_bytes, started_at = excluded.started_at,
        abandoned_at = null;
  if v_open then
    perform app.quote_pdf_abandon(v_org, v_job.path);
  end if;
  return jsonb_build_object('status', 'upload', 'path', v_path);
end;
$$;
revoke all on function app.quote_pdf_remake(public.quotes, public.files, uuid, bigint, text, text, text)
  from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Review M1: an open attempt's path never leaks. A job removed with its file (a privacy erasure through app.quote_pdf_drop,
-- the business's own deletion) queues it; the nightly sweep queues one left for a day.
-- ----------------------------------------------------------------------------
create or replace function app.quote_pdf_remakes_gone() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if old.path is not null and old.done_at is null and old.abandoned_at is null then
    perform app.quote_pdf_abandon(old.organization_id, old.path);
  end if;
  return null;
end;
$$;
revoke all on function app.quote_pdf_remakes_gone() from public, anon, authenticated, service_role;

create or replace trigger quote_pdf_remakes_gone after delete on app.quote_pdf_remakes
  for each row execute function app.quote_pdf_remakes_gone();

create or replace function app.quote_pdf_remake_sweep(p_limit integer default 1000) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  r record;
  v_done integer := 0;
begin
  for r in
    select j.organization_id, j.file_id, j.path
      from app.quote_pdf_remakes j
     where j.done_at is null and j.abandoned_at is null and j.path is not null
       and j.started_at < now() - interval '1 day'
     order by j.started_at
     limit greatest(1, least(coalesce(p_limit, 1000), 10000))
     for update skip locked
  loop
    perform app.quote_pdf_abandon(r.organization_id, r.path);
    update app.quote_pdf_remakes j set abandoned_at = now() where j.file_id = r.file_id;
    v_done := v_done + 1;
  end loop;
  return v_done;
end;
$$;
revoke all on function app.quote_pdf_remake_sweep(integer) from public, anon, authenticated, service_role;

-- before the nightly file cleanup (crm-file-cleanup, 03:00 UTC), so the swept paths go the same night
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-quote-pdf-remake-sweep', '40 2 * * *', 'select app.quote_pdf_remake_sweep();');
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- public.quote_pdf_store: 020995's body, plus the hand-over above for a confirmed row without a fingerprint
-- ----------------------------------------------------------------------------
create or replace function public.quote_pdf_store(p_org uuid, p_quote uuid, p_user uuid, p_size bigint, p_sha256 text, p_name text,
                                                  p_path text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
  v_file  public.files;
  v_obj   record;
  v_path  text;
begin
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' or p_size is null or p_size < 1 or p_size > 26214400
     or coalesce(btrim(p_name), '') = '' or char_length(p_name) > 200 or p_name ~ '[/\\]' or lower(p_name) !~ '\.pdf$' then
    raise exception 'invalid PDF details' using errcode = '22023', hint = 'quote_pdf:invalid';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = p_org and q.id = p_quote;
  if not found or not app.quote_pdf_user_may(p_org, p_user, v_quote.deal_id, v_quote.contact_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- one render at a time per quote
  perform pg_advisory_xact_lock(hashtextextended('quote_pdf:' || p_quote::text, 0));
  select * into v_file from public.files f where f.organization_id = p_org and f.quote_id = p_quote for update;
  if found and v_file.unconfirmed_since is null then
    -- QUO-06 follow-up (owner, 26 October 2026, answer 1 (ג)): a PDF kept before the fingerprint existed is made again by
    -- the server, once (app.quote_pdf_remake); never counted in the quota (no new row, so files_quote_pdf never fires)
    if v_file.sha256 is null then
      return app.quote_pdf_remake(v_quote, v_file, p_user, p_size, p_sha256, btrim(p_name), p_path);
    end if;
    -- a stale render that uploaded to its own path: that object is not the file
    if p_path is distinct from v_file.storage_path then
      perform app.quote_pdf_abandon(p_org, p_path);
    end if;
    return jsonb_build_object('status', 'stored', 'file_id', v_file.id);
  end if;
  if v_quote.status = 'draft' then
    raise exception 'a draft quote has no PDF' using errcode = 'P0001', hint = 'quote_pdf:draft';
  end if;
  if v_quote.status not in ('sent', 'viewed') then
    raise exception 'a quote''s PDF is made while it is sent or viewed' using errcode = 'P0001', hint = 'quote_pdf:closed';
  end if;
  if not app.org_has_feature(p_org, 'quotes') then
    raise exception 'quotes are not in the plan' using errcode = 'P0001', hint = 'feature:quotes';
  end if;

  if v_file.id is null then
    -- files_before_insert sets the path (`<org>/<file id>`, this attempt's own) and no uploader (no session);
    -- files_quote_pdf takes the quota and the rate
    insert into public.files (organization_id, quote_id, name, mime_type, size_bytes, unconfirmed_since, sha256)
    values (p_org, p_quote, btrim(p_name), 'application/pdf', p_size, now(), p_sha256)
    returning * into v_file;
    update public.files f set upload_checked_at = now() where f.organization_id = p_org and f.id = v_file.id;
    perform app.quote_pdf_abandon(p_org, p_path);
    return jsonb_build_object('status', 'upload', 'path', v_file.storage_path);
  end if;

  if v_file.sha256 = p_sha256 and (p_path is null or p_path = v_file.storage_path) then
    -- the second call of the attempt that holds the row: its own path must hold a PDF of the stated size
    select * into v_obj from app.record_file_object(v_file.storage_path);
    if v_obj.present and v_obj.size = v_file.size_bytes and v_obj.mimetype = 'application/pdf' then
      update public.files f set unconfirmed_since = null, upload_checked_at = now()
       where f.organization_id = p_org and f.id = v_file.id;
      return jsonb_build_object('status', 'stored', 'file_id', v_file.id);
    end if;
    if not v_obj.present then
      return jsonb_build_object('status', 'upload', 'path', v_file.storage_path);
    end if;
    -- something else is on the attempt's path: leave it to the cleanup and start a fresh path
  else
    -- another attempt holds the row; a stale caller's own upload is queued for the cleanup
    if p_path is distinct from v_file.storage_path then
      perform app.quote_pdf_abandon(p_org, p_path);
    end if;
    -- after two minutes without its object the row is taken over (an earlier session's waiting row, from before this
    -- change, is taken over the same way and loses its uploader)
    if coalesce(v_file.upload_checked_at, v_file.created_at) > now() - interval '2 minutes' then
      return jsonb_build_object('status', 'busy');
    end if;
  end if;

  -- a fresh path for this attempt; the abandoned one goes to the orphan cleanup once no row uses it
  v_path := p_org::text || '/' || gen_random_uuid()::text;
  update public.files f
     set storage_path = v_path, sha256 = p_sha256, size_bytes = p_size, name = btrim(p_name), uploaded_by = null,
         upload_checked_at = now()
   where f.organization_id = p_org and f.id = v_file.id;
  perform app.quote_pdf_abandon(p_org, v_file.storage_path);
  return jsonb_build_object('status', 'upload', 'path', v_path);
end;
$$;
revoke all on function public.quote_pdf_store(uuid, uuid, uuid, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.quote_pdf_store(uuid, uuid, uuid, bigint, text, text, text) to service_role;
