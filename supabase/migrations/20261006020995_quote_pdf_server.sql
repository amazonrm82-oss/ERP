-- =============================================================================
-- QUO-06 follow-ups (owner, 26 October 2026, DECISIONS.md "PDF של הצעת מחיר: פרטים", answers (3) and (1)):
-- the server alone writes a quote's PDF, with its SHA-256; and the customer downloads it from the quote's link
-- =============================================================================
-- Two new uses of the service-role key, approved under fixed conditions (CLAUDE.md hard rule 5): one security definer
-- function granted to service_role only per use, no direct table access, database tests, an independent review.
--
-- (3) Server-only write. Until now the person who sent the quote wrote the files row and the object with their own session,
--     so whoever may edit the quote could put another file there through the API. Now:
--   * The app checks the person's right with their own session (public.quote_pdf_allowed, invoker: the quote is sent or
--     viewed, the business writable with the `quotes` flag, the caller may edit its deal or contact), renders the PDF, and
--     hands size and SHA-256 to public.quote_pdf_store (service_role only), which checks again for that user
--     (app.quote_pdf_user_may: active non-viewer member of a writable business who may edit the deal or contact, the rule of
--     app.can_edit_record; keep the two in step), takes the quota through the existing trigger files_quote_pdf
--     (app.pdf_take: max_pdf_per_month, 30 a minute, the 80% notice) and answers the one path the server may upload to.
--   * The path belongs to the quote version's one files row (files_quote_pdf_one): `<org>/<file id>` for the first attempt,
--     a fresh `<org>/<uuid>` for a takeover (M1 below), fixed for good once the row is confirmed. The server uploads only to
--     the path it was answered, with the service key and upsert off, then calls the same function again naming that path; it
--     confirms the row when the object there is a PDF of the stated size and the SHA-256 sent is the one stored.
--     files.sha256 is server-only (no client grant); every serving compares the bytes with it.
--   * authenticated loses every write path: no insert grant on files.quote_id, the files_insert policy refuses a quote's
--     PDF, and record_files_insert on storage refuses an object for a quote's row. A server row has no uploader, so
--     confirm_file_upload never confirms it for a person.
--   * Kept rules unchanged: one PDF per sent version, kept forever (files_keep_attached), removed only by a privacy erasure
--     (app.quote_pdf_drop), a waiting row's count given back when it is removed (files_quote_pdf_return).
--
-- (1) Customer download: public.quote_public_pdf(token, ip_hash) (service_role only) follows the rules of quote_public
--     (app.quote_link_usable, app.quote_shown_version): only the version the page shows, only while the page shows it in
--     full (open or accepted); a status page, a cancelled or erased quote gets no file. It counts in the link's view window
--     (120 per 10 minutes, shared with the page) and in its own per-sender window (20 per 10 minutes, keyed IP hash scoped
--     to the quote, 1,024 reused buckets, no hash kept), counts a view (app.quote_mark_viewed), and answers only the storage
--     path, the SHA-256 and the file name. public.quote_public adds `pdf` (a stored file exists) for the page's link.
--
-- Review follow-ups (lead, 26 October 2026):
-- * M1: every render attempt writes to its own fresh path under `<org>/`: the first is the row's `<org>/<file id>`; a
--   takeover moves the waiting row to `<org>/<new uuid>` and queues the abandoned path for the orphan cleanup
--   (app.orphan_files, record-files; constraint files_path allows `<org>/<uuid>` on a quote's row only); the server uploads with upsert off, and a stale render's second call names its own path,
--   which is queued too when the row no longer uses it. So a late upload never lands on the path that is confirmed, and the
--   confirmed row's path never changes again. Storage keeps no SHA-256 of an object, so the confirmation checks presence, type
--   and size on the attempt's own path; the SHA-256 is checked on every serving.
-- * M2: app.reconcile_pending_files (020955's body) skips a quote's server row (quote_id and sha256 set): only
--   public.quote_pdf_store confirms it.
-- * L1: the person's two-step rule (aal2, app.membership_role) is enforced by public.quote_pdf_allowed, which the app calls
--   with the person's own session before it renders; app.quote_pdf_user_may repeats the role and edit rule for the named
--   user, not the session's aal.
-- * L4, L5: reviewed and left as they are (lead's decision, 26 October 2026).
--
-- Every statement is safe to run twice. No drops, no row removal.

alter table public.files add column if not exists sha256 text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'files_sha256_shape') then
    alter table public.files add constraint files_sha256_shape
      check (sha256 is null or (quote_id is not null and sha256 ~ '^[0-9a-f]{64}$'));
  end if;
end;
$$;

-- review M1: a quote's server row moves to a fresh path of its own business for each render attempt, so its path is
-- `<org>/<uuid>` rather than `<org>/<file id>`; every other file keeps the exact rule of 0019
alter table public.files drop constraint if exists files_path;
alter table public.files add constraint files_path
  check (storage_path = organization_id::text || '/' || id::text
         or (quote_id is not null
             and storage_path ~ ('^' || organization_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')));

-- a person no longer names a quote on a file (the column is written by public.quote_pdf_store only)
revoke insert (quote_id) on public.files from authenticated;

-- ----------------------------------------------------------------------------
-- Policies: the files_insert policy of 020955 without its quote branch; Storage refuses an object for a quote's row
-- ----------------------------------------------------------------------------
alter policy files_insert on public.files
  with check (app.can_write(organization_id)
              and uploaded_by = (select auth.uid())
              and case when accounting_document_id is not null
                       then app.can_record_documents(organization_id) and app.org_writable(organization_id)
                            and app.org_has_feature(organization_id, 'documents')
                            and exists (select 1 from public.accounting_documents d
                                         where d.organization_id = files.organization_id and d.id = files.accounting_document_id)
                       when payment_id is not null
                       then app.can_record_payments(organization_id) and app.org_writable(organization_id)
                            and app.org_has_feature(organization_id, 'payments')
                            and exists (select 1 from public.payments pm
                                         where pm.organization_id = files.organization_id and pm.id = files.payment_id)
                       -- QUO-06 (owner's answer 3): only the server writes a quote's PDF
                       when quote_id is not null
                       then false
                       else app.can_read_activity_subject(lead_id, contact_id, company_id, deal_id)
                            and (activity_id is null
                                 or exists (select 1 from public.activities a
                                             where a.organization_id = files.organization_id and a.id = files.activity_id))
                  end);

alter policy record_files_insert on storage.objects
  with check (bucket_id = 'record-files'
              and exists (select 1 from public.files f
                           where f.storage_path = objects.name
                             and f.uploaded_by = (select auth.uid())
                             and f.unconfirmed_since is not null
                             and f.quote_id is null));

-- ----------------------------------------------------------------------------
-- The person's right, asked with their own session (the app calls it before rendering)
-- ----------------------------------------------------------------------------
create or replace function public.quote_pdf_allowed(p_org uuid, p_quote uuid) returns boolean
language sql stable security invoker
set search_path = ''
as $$
  select exists (
    select 1 from public.quotes q
     where q.organization_id = p_org and q.id = p_quote
       and q.status in ('sent', 'viewed')
       and app.can_write(q.organization_id)
       and app.org_writable(q.organization_id)
       and app.org_has_feature(q.organization_id, 'quotes')
       and app.quote_editable(q.organization_id, q.deal_id, q.contact_id))
$$;
revoke all on function public.quote_pdf_allowed(uuid, uuid) from public, anon;
grant execute on function public.quote_pdf_allowed(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The same right for a named user, checked again inside the service-role function: app.can_edit_record's rule
-- (keep the two in step) over the quote's deal, else its contact (app.quote_editable)
-- ----------------------------------------------------------------------------
create or replace function app.quote_pdf_user_may(p_org uuid, p_user uuid, p_deal uuid, p_contact uuid) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_role  public.membership_role;
  v_owner uuid;
  v_team  uuid;
begin
  if p_user is null or not app.org_writable(p_org) then
    return false;
  end if;
  select m.role into v_role
    from public.memberships m
   where m.organization_id = p_org and m.user_id = p_user and m.status = 'active';
  if v_role is null or v_role = 'viewer' then
    return false;
  end if;
  if p_deal is not null then
    select d.owner_id, d.team_id into v_owner, v_team
      from public.deals d where d.organization_id = p_org and d.id = p_deal and d.deleted_at is null;
  elsif p_contact is not null then
    select c.owner_id, c.team_id into v_owner, v_team
      from public.contacts c where c.organization_id = p_org and c.id = p_contact and c.deleted_at is null;
  else
    return false;
  end if;
  if not found then
    return false;
  end if;
  if v_role in ('owner', 'admin') or (v_owner is not null and v_owner = p_user) then
    return true;
  end if;
  return v_role = 'manager' and v_team is not null and exists (
    with recursive chain as (
      select t.id, t.parent_team_id, 1 as depth
        from public.teams t where t.id = v_team
      union all
      select t.id, t.parent_team_id, c.depth + 1
        from public.teams t join chain c on t.id = c.parent_team_id
       where c.depth < 10
    )
    select 1 from chain c join public.team_members tm on tm.team_id = c.id
     where tm.user_id = p_user and tm.is_manager);
end;
$$;
revoke all on function app.quote_pdf_user_may(uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- (3) The one service-role entry for writing: answers {status: upload, path} (upload the bytes there with upsert off, then
-- call again naming that path), {status: stored, file_id} or {status: busy} (another render is on its way); refusals raise
-- like a person's insert did
-- ----------------------------------------------------------------------------
create or replace function app.quote_pdf_abandon(p_org uuid, p_path text) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  -- only a path of this business that no file row uses: the queue is keyed on the path alone and record-files paths are
  -- always claimable (app.orphan_claimable)
  if p_path is null or p_path !~ ('^' || p_org::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    return;
  end if;
  if exists (select 1 from public.files f where f.storage_path = p_path) then
    return;
  end if;
  insert into app.orphan_files (storage_path, bucket) values (p_path, 'record-files') on conflict do nothing;
end;
$$;
revoke all on function app.quote_pdf_abandon(uuid, text) from public, anon, authenticated, service_role;

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

-- ----------------------------------------------------------------------------
-- M2: 020955's app.reconcile_pending_files, skipping a quote's server row (only public.quote_pdf_store confirms it)
-- ----------------------------------------------------------------------------
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
    select f.organization_id, f.id, f.storage_path, f.accounting_document_id, f.payment_id, f.quote_id
      from public.files f
     where f.unconfirmed_since is not null
       -- QUO-06 follow-up (review M2): a quote's PDF written by the server is confirmed by public.quote_pdf_store only
       and not (f.quote_id is not null and f.sha256 is not null)
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
      if v_problem is null and (r.accounting_document_id is not null or r.payment_id is not null) and not (v_obj.mimetype = any (app.document_file_types())) then
        v_problem := 'type';
      end if;
      if v_problem is null and r.quote_id is not null and v_obj.mimetype is distinct from 'application/pdf' then
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


-- ----------------------------------------------------------------------------
-- (1) The customer's download: a per-sender window, keyed by the server's IP hash scoped to the quote (no hash kept)
-- ----------------------------------------------------------------------------
create table if not exists app.quote_pdf_download_counts (
  organization_id uuid not null,
  quote_id        uuid not null,
  bucket          integer not null check (bucket between 0 and 1023),
  window_start    timestamptz not null,
  downloads       integer not null,
  primary key (quote_id, bucket),
  constraint quote_pdf_download_counts_quote_fk foreign key (organization_id, quote_id)
    references public.quotes (organization_id, id) on delete cascade
);
create index if not exists quote_pdf_download_counts_quote_idx on app.quote_pdf_download_counts (organization_id, quote_id);
alter table app.quote_pdf_download_counts enable row level security;
revoke all on app.quote_pdf_download_counts from public, anon, authenticated, service_role;

create or replace function app.quote_link_sender(p_quote uuid, p_hash text) returns text
language sql immutable
set search_path = ''
as $$
  select case when p_hash is null or p_quote is null then null
              else encode(sha256(convert_to('quote:' || p_quote::text || ':' || p_hash, 'UTF8')), 'hex') end
$$;
revoke all on function app.quote_link_sender(uuid, text) from public, anon, authenticated, service_role;

create or replace function public.quote_public_pdf(p_token text, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_link    app.quote_links;
  v_quote   public.quotes;
  v_shown   public.quotes;
  v_count   integer;
  v_bucket  integer;
  v_file    public.files;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_link from app.quote_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = v_link.organization_id and q.id = v_link.quote_id;
  -- the one rule for a sent quote's link (quote_public)
  if not app.quote_link_usable(v_quote) then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;

  -- the link's own window, shared with the page (120 in 10 minutes), counted first
  update app.quote_links l
     set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
         window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end
   where l.quote_id = v_link.quote_id
  returning l.window_count into v_count;
  if v_count > 120 then
    return jsonb_build_object('rate_limited', true);
  end if;
  -- FXS-11: 20 downloads per sender in 10 minutes, by the server's keyed IP hash scoped to this quote
  if p_ip_hash is not null then
    v_bucket := ((hashtextextended(app.quote_link_sender(v_quote.id, p_ip_hash), 0) % 1024) + 1024) % 1024;
    insert into app.quote_pdf_download_counts as dc (organization_id, quote_id, bucket, window_start, downloads)
    values (v_quote.organization_id, v_quote.id, v_bucket, now(), 1)
    on conflict (quote_id, bucket) do update
      set window_start = case when dc.window_start > now() - interval '10 minutes' then dc.window_start else now() end,
          downloads = case when dc.window_start > now() - interval '10 minutes' then dc.downloads + 1 else 1 end
    returning dc.downloads into v_count;
    if v_count > 20 then
      return jsonb_build_object('rate_limited', true);
    end if;
  end if;

  -- the version the page shows (quote_public's chain walk), only while the page shows it in full
  v_shown := app.quote_shown_version(v_quote);
  if v_shown.customer_deleted_at is not null then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  if not (app.quote_offer_open(v_shown) or v_shown.status = 'accepted') then
    return jsonb_build_object('unavailable', true);
  end if;
  select * into v_file from public.files f
   where f.organization_id = v_shown.organization_id and f.quote_id = v_shown.id
     and f.unconfirmed_since is null and f.sha256 is not null;
  if not found then
    return jsonb_build_object('unavailable', true);
  end if;

  -- QUO-10: a download is a view of the quote shown
  perform app.quote_mark_viewed(v_shown);
  return jsonb_build_object('path', v_file.storage_path, 'sha256', v_file.sha256, 'name', v_file.name);
end;
$$;
revoke all on function public.quote_public_pdf(text, text) from public, anon, authenticated;
grant execute on function public.quote_public_pdf(text, text) to service_role;

-- ----------------------------------------------------------------------------
-- quote_public: 020550's body, plus `pdf` (the version shown has a stored, fingerprinted file) for the page's link
-- ----------------------------------------------------------------------------
create or replace function public.quote_public(p_token text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_link app.quote_links;
  v_quote public.quotes;
  v_count integer;
  v_design public.quote_designs;
  v_settings public.org_document_settings;
  v_org public.organizations;
  v_show_details boolean;
  v_show_logo boolean;
  v_lines jsonb;
  v_built_with boolean;
  v_schedule jsonb;
  -- QUO-12: the quote the link was made for, when the page shows a newer version of it
  v_opened public.quotes;
  v_next public.quotes;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_link from app.quote_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = v_link.organization_id and q.id = v_link.quote_id;

  -- owner, 19 October 2026: the link of a quote that was sent never answers not found. Not found only for a token that does
  -- not exist or was revoked (its hash cleared), a draft, a customer erased or purged (customer_deleted_at), a business whose
  -- public pages are closed, or one without quotes
  if not app.quote_link_usable(v_quote) then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;

  -- 120 views per link in 10 minutes; counted first, so the limit holds under parallel load
  update app.quote_links l
     set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
         window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end
   where l.quote_id = v_link.quote_id
  returning l.window_count into v_count;
  if v_count > 120 then
    return jsonb_build_object('rate_limited', true);
  end if;

  -- the newest version of the chain that was ever sent (QUO-12, the QUO-11 review rule), whether or not it has a link of its
  -- own; never an older one
  v_next := app.quote_shown_version(v_quote);
  if v_next.customer_deleted_at is not null then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  if v_next.id is distinct from v_quote.id then
    v_opened := v_quote;
    v_quote := v_next;
  end if;

  -- declined, cancelled, or past its date: a status page with no prices, lines or a way to sign (owner, 19 October 2026: an
  -- accepted quote is shown in full, with the day it was accepted and no way to decide)
  if not app.quote_offer_open(v_quote) and v_quote.status <> 'accepted' then
    select * into v_org from public.organizations o where o.id = v_quote.organization_id;
    select * into v_design from public.quote_designs d where d.organization_id = v_quote.organization_id;
    select * into v_settings from public.org_document_settings s where s.organization_id = v_quote.organization_id;
    return jsonb_build_object('status_page', jsonb_build_object(
      'state', case when v_quote.status in ('rejected', 'cancelled') then v_quote.status else 'expired' end,
      'number', v_quote.number_display,
      'title', v_quote.title,
      'valid_until', v_quote.valid_until,
      -- documents use the registered name when set (owner)
      'business', coalesce(nullif(btrim(v_settings.legal_name), ''), v_org.name),
      'logo', case when coalesce(v_design.show_logo, true) then v_org.logo_path end,
      'color', coalesce(v_design.accent_color, v_org.brand_color),
      'phone', coalesce(nullif(btrim(v_settings.phone), ''), nullif(btrim(v_org.phone), '')),
      'replaced', case when v_opened.id is not null then jsonb_build_object('number', v_opened.number_display) end,
      -- a newer version is being prepared (QUO-12 answer 7)
      'draft_version', exists (select 1 from public.quotes d
                                where d.organization_id = v_quote.organization_id and d.previous_id = v_quote.id
                                  and d.status = 'draft')));
  end if;

  -- QUO-10: the customer opened the quote shown; count the view, and the first one marks it viewed and tells its owner
  if app.quote_mark_viewed(v_quote) then
    v_quote.status := 'viewed';
  end if;

  select * into v_org from public.organizations o where o.id = v_quote.organization_id;
  select * into v_design from public.quote_designs d where d.organization_id = v_quote.organization_id;
  select * into v_settings from public.org_document_settings s where s.organization_id = v_quote.organization_id;
  -- QUO-05: no design row = the defaults (logo and business details shown)
  v_show_details := coalesce(v_design.show_business_details, true);
  v_show_logo := coalesce(v_design.show_logo, true);

  select coalesce(jsonb_agg(jsonb_build_object(
           'position', l.position,
           'kind', l.kind,
           'name', l.name,
           'description', l.description,
           'unit_name', l.unit_name,
           'quantity', l.quantity,
           'unit_price_agorot', l.unit_price_agorot,
           'discount_bp', l.discount_bp,
           'discount_agorot', l.discount_agorot,
           'vat_exempt', l.vat_exempt,
           'billing', l.billing,
           'is_optional', l.is_optional,
           'optional_selected', l.optional_selected,
           'total_agorot', l.total_agorot) order by l.position, l.id), '[]'::jsonb)
    into v_lines
    from public.quote_lines l
   where l.organization_id = v_quote.organization_id and l.quote_id = v_quote.id;

  -- GAP-09: the payment schedule, with each row's share of the total (the shares add up to the total)
  v_schedule := app.quote_schedule(v_quote.organization_id, v_quote.id, v_quote.total_agorot);

  begin
    v_built_with := coalesce(app.show_built_with(v_quote.organization_id), true);
  exception when others then
    v_built_with := true;
  end;

  return jsonb_build_object(
    'quote', jsonb_build_object(
      'number', v_quote.number_display,
      'title', v_quote.title,
      'status', v_quote.status,
      'quote_date', v_quote.quote_date,
      'valid_until', v_quote.valid_until,
      'sent_at', v_quote.sent_at,
      'prices_include_vat', v_quote.prices_include_vat,
      'no_vat_reason', v_quote.no_vat_reason,
      'no_vat_note', v_quote.no_vat_note,
      'discount_bp', v_quote.discount_bp,
      'discount_agorot', v_quote.discount_agorot,
      'notes', v_quote.notes,
      'terms', v_quote.terms,
      'vat_rate_bp', v_quote.vat_rate_bp,
      'subtotal_agorot', v_quote.subtotal_agorot,
      'discount_total_agorot', v_quote.discount_total_agorot,
      'net_total_agorot', v_quote.net_total_agorot,
      'vat_agorot', v_quote.vat_agorot,
      'total_agorot', v_quote.total_agorot,
      'currency', v_quote.currency),
    -- the customer as printed when the quote was sent (QUO-07); never the live record
    'customer', jsonb_build_object('name', v_quote.customer_name, 'contact', v_quote.customer_contact_name),
    'lines', v_lines,
    'schedule', v_schedule,
    -- documents use the registered name when set (owner); the rest only when the design shows the details
    'business', jsonb_build_object(
      'name', coalesce(nullif(btrim(v_settings.legal_name), ''), v_org.name),
      'tax_id', case when v_show_details then v_settings.tax_id end,
      'address_line', case when v_show_details then v_settings.address_line end,
      'city', case when v_show_details then v_settings.city end,
      'postal_code', case when v_show_details then v_settings.postal_code end,
      'phone', case when v_show_details then v_settings.phone end,
      'email', case when v_show_details then v_settings.email end),
    'design', jsonb_build_object(
      'header_text', v_design.header_text,
      'footer_text', v_design.footer_text,
      'show_logo', v_show_logo,
      'show_business_details', v_show_details,
      'accent_color', v_design.accent_color),
    'brand', jsonb_build_object('logo', case when v_show_logo then v_org.logo_path end, 'color', v_org.brand_color),
    'built_with', v_built_with,
    -- QUO-12: the number the customer's link was made for, when this is a newer version of it (else null)
    'replaced', case when v_opened.id is not null then jsonb_build_object('number', v_opened.number_display) end,
    -- owner, 19 October 2026: the day an accepted quote was accepted, in the business's zone (null otherwise)
    'accepted_on', case when v_quote.status = 'accepted' then
                     (select (d.decided_at at time zone app.intake_zone(v_org.timezone))::date
                        from public.quote_decisions d
                       where d.organization_id = v_quote.organization_id and d.quote_id = v_quote.id and d.decision = 'accepted') end,
    -- QUO-12 (owner, 19 October 2026): a newer version is being prepared (a draft after the quote shown); no id or content
    'draft_version', exists (select 1 from public.quotes d
                              where d.organization_id = v_quote.organization_id and d.previous_id = v_quote.id
                                and d.status = 'draft'),
    -- GAP-10: the quote this one adds to (its number), and the accepted addenda of this one; numbers, titles and totals only
    'addendum', (select jsonb_build_object('number', o.number_display) from public.quotes o
                  where v_quote.addendum_of is not null and o.organization_id = v_quote.organization_id and o.id = v_quote.addendum_of),
    -- QUO-06 (owner's answer 1): the customer may download the stored PDF of the version shown
    'pdf', exists (select 1 from public.files f
                    where f.organization_id = v_quote.organization_id and f.quote_id = v_quote.id
                      and f.unconfirmed_since is null and f.sha256 is not null),
    'addenda', coalesce((select jsonb_agg(jsonb_build_object('number', a.number_display, 'title', a.title, 'total_agorot', a.total_agorot)
                                          order by a.sent_at, a.number)
                           from public.quotes a
                          where a.organization_id = v_quote.organization_id and a.addendum_of = v_quote.id and a.status = 'accepted'),
                        '[]'::jsonb));
end;
$$;
revoke all on function public.quote_public(text) from public, anon, authenticated;
grant execute on function public.quote_public(text) to service_role;
