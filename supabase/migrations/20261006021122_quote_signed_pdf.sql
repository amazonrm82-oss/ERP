-- =============================================================================
-- QUO-09 signed PDF (owner, 1 November 2026, DECISIONS.md "מסמכי PDF שנשארו בגל 2" answer (3) א, and answer (33) ב): when the
-- customer accepts a quote on its page, the server keeps a new PDF of the accepted quote with the signature
-- =============================================================================
-- An approved use of the service-role key under QUO-06's pattern and conditions (CLAUDE.md hard rule 5: one security definer
-- function granted to service_role only per use, no direct table access, SHA-256 on every serving, database tests, an
-- independent review). What the signed PDF holds: the lines as accepted (optional lines as chosen) and the accepted totals of
-- the quote row (QUO-08 recomputes them at acceptance), the signer's name, the drawn signature or the typed name, the date and
-- time of the decision in the business's zone, the wording version and the fingerprint of the decision
-- (quote_decisions.choice_sha256, else content_sha256).
--
-- * Kept as a NEWER VERSION of the quote's stored PDF (REC-07's chain, files.previous_id): files.quote_signed (true|null,
--   server-only: no client grant) marks it; at most one per quote (files_quote_signed_one). It follows the quote's as-sent file
--   (the one files row of the quote that is not signed), whatever that row's state; a quote without one (sent before QUO-06, or
--   its PDF failed) gets the signed PDF as its first file. A row that is not signed is still never a version
--   (hint quote_pdf:version). files_quote_pdf_shape no longer forbids previous_id; the one-PDF-per-quote index
--   files_quote_pdf_one gives way to files_quote_pdf_root (one first file per quote) + files_one_newer (one newer per file).
--   files_quote_pdf_one is removed in the pasted 20261006021123_quote_signed_pdf_index (an index drop does not pass the
--   connector); until it is pasted a signed version after an as-sent file is refused by that index (23505) and the staff
--   button makes it later. A signed first file (no as-sent one) works at once.
-- * Who is checked, two entries (one per use):
--   (1) the customer's decide route, right after public.quote_public_answer answered 'accepted', with no staff session:
--       public.quote_signed_pdf_public(token) reads what to render: the link rule (app.quote_link_usable), the version the
--       page shows (app.quote_shown_version), accepted, its accepted decision not erased, no confirmed signed PDF yet; then the
--       page's own answer (public.quote_public, the same document the customer sees, without counting a view: app.quote_mark_viewed
--       skips the quote named by the transaction setting app.quote_view_quiet) plus the signature block. The route renders and
--       public.quote_signed_pdf_public_store(token, ...) writes, under the same token checks. No user: the token is the right,
--       and only an accepted quote with its decision and no signed PDF is written.
--   (2) staff ("יצירת PDF חתום", when (1) failed: a full quota, a render error): public.quote_signed_pdf_allowed(org, quote)
--       with the person's own session (security definer: a member who may edit the quote does not read quote_decisions under
--       RLS, so it answers the signature block itself, only when app.can_write (the two-step rule), a writable business with the
--       `quotes` flag and app.quote_editable hold, the quote is accepted with its decision and no signed PDF); then
--       public.quote_signed_pdf_store(org, quote, user, ...) (service_role) checks that user again (app.quote_pdf_user_may).
--   Both write through app.quote_signed_pdf_write (no grants): accepted, the customer not erased, the decision accepted and not
--   erased, the fingerprint the render printed equal to the decision's (else {status: changed}, nothing written), the flag,
--   then QUO-06's upload/stored/busy with the two-minute takeover and abandoned paths queued for the orphan cleanup.
-- * Quota: counted in max_pdf_per_month through trigger files_quote_pdf (app.pdf_take) on the signed row's insert. A failure
--   never undoes the acceptance (the route calls it after the decision committed, and swallows any error).
-- * Customer download: public.quote_public_pdf serves the newest confirmed, fingerprinted version (the signed one first).
--   public.quote_public_version answers pdf_as_sent only while there is no confirmed signed PDF. Staff read every version
--   (files_select follows the quote).
-- * Erasure: app.quote_pdf_drop (pasted 020960) removes every files row of the erased customer's detached quotes, the signed
--   version included; unchanged.
-- Redefined from their latest bodies: app.files_quote_pdf (020955), public.quote_pdf_store (021015), public.quote_public_pdf
-- (020995), public.quote_public_version (021117), app.quote_mark_viewed (020455). Every statement is safe to run twice. No drops,
-- no row removal.

alter table public.files add column if not exists quote_signed boolean;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'files_quote_signed_shape') then
    alter table public.files add constraint files_quote_signed_shape
      check (quote_signed is null or (quote_signed and quote_id is not null));
  end if;
end;
$$;

-- a quote's file may now name its earlier version (the signed PDF after the as-sent one)
alter table public.files drop constraint if exists files_quote_pdf_shape;
alter table public.files add constraint files_quote_pdf_shape
  check (quote_id is null
         or (activity_id is null and custom_field_key is null and mime_type = 'application/pdf'));

-- one first PDF per quote; with files_one_newer a quote's files are one line (the as-sent file, then the signed one)
create unique index if not exists files_quote_pdf_root on public.files (organization_id, quote_id)
  where quote_id is not null and previous_id is null;
-- one signed PDF per quote
create unique index if not exists files_quote_signed_one on public.files (organization_id, quote_id)
  where quote_signed;

-- ----------------------------------------------------------------------------
-- 020955's app.files_quote_pdf, plus the signed version
-- ----------------------------------------------------------------------------
create or replace function app.files_quote_pdf() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
  v_sent  public.files;
begin
  if new.quote_id is null then
    return new;
  end if;
  select * into v_quote from public.quotes q where q.organization_id = new.organization_id and q.id = new.quote_id;
  if auth.uid() is not null
     and not (found and app.can_write(new.organization_id) and app.org_writable(new.organization_id)
              and v_quote.status in ('sent', 'viewed')
              and app.quote_editable(v_quote.organization_id, v_quote.deal_id, v_quote.contact_id)) then
    return new;
  end if;
  if v_quote.id is null or v_quote.status = 'draft' then
    raise exception 'a draft quote has no PDF' using errcode = 'P0001', hint = 'quote_pdf:draft';
  end if;
  if coalesce(new.quote_signed, false) then
    -- QUO-09 (answer (33) ב): the signed PDF of an accepted quote whose acceptance was not erased
    if v_quote.status <> 'accepted' or v_quote.customer_deleted_at is not null
       or not exists (select 1 from public.quote_decisions d
                       where d.organization_id = v_quote.organization_id and d.quote_id = v_quote.id
                         and d.decision = 'accepted' and d.erased_at is null) then
      raise exception 'a signed PDF is made for an accepted quote' using errcode = 'P0001', hint = 'quote_pdf:not_accepted';
    end if;
    -- it follows the quote's as-sent file when there is one (else it is the first file)
    select * into v_sent from public.files f
     where f.organization_id = new.organization_id and f.quote_id = new.quote_id and f.quote_signed is null;
    if new.previous_id is distinct from v_sent.id then
      raise exception 'a signed PDF follows the quote''s PDF as sent' using errcode = 'P0001', hint = 'quote_pdf:version';
    end if;
  else
    -- a PDF as sent is never a version
    if new.previous_id is not null then
      raise exception 'a quote''s PDF as sent is its first file' using errcode = 'P0001', hint = 'quote_pdf:version';
    end if;
    -- review L3: made later only while the quote is still the open offer that was sent (sent or viewed), so a file made
    -- after an answer, an expiry or a cancel is never taken for the version that was sent
    if v_quote.status not in ('sent', 'viewed') then
      raise exception 'a quote''s PDF is made while it is sent or viewed' using errcode = 'P0001', hint = 'quote_pdf:closed';
    end if;
  end if;
  if not app.org_has_feature(new.organization_id, 'quotes') then
    raise exception 'quotes are not in the plan' using errcode = 'P0001', hint = 'feature:quotes';
  end if;
  perform app.pdf_take(new.organization_id);
  return new;
end;
$$;
revoke all on function app.files_quote_pdf() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The signature block of an accepted decision, as the PDF prints it (the drawn PNG or the typed name; no ID number, IP or
-- browser). Internal: no grants.
-- ----------------------------------------------------------------------------
create or replace function app.quote_signature_block(p_quote public.quotes) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'signer_name', d.signer_name,
           'kind', d.signature_kind,
           'image', case when d.signature_kind = 'drawn' then d.signature_image end,
           'decided_at', d.decided_at,
           'time_zone', app.intake_zone(o.timezone),
           'wording_version', d.wording_version,
           'fingerprint', coalesce(d.choice_sha256, d.content_sha256))
    from public.quote_decisions d
    join public.organizations o on o.id = d.organization_id
   where d.organization_id = p_quote.organization_id and d.quote_id = p_quote.id
     and d.decision = 'accepted' and d.erased_at is null
$$;
revoke all on function app.quote_signature_block(public.quotes) from public, anon, authenticated, service_role;

-- a confirmed signed PDF of the quote exists (internal)
create or replace function app.quote_signed_pdf_done(p_quote public.quotes) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.files f
                  where f.organization_id = p_quote.organization_id and f.quote_id = p_quote.id
                    and f.quote_signed and f.unconfirmed_since is null and f.sha256 is not null)
$$;
revoke all on function app.quote_signed_pdf_done(public.quotes) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The one writer of a signed PDF (called by the two service-role entries below, after their own check of the caller).
-- Answers like quote_pdf_store: {status: upload, path}, {status: stored, file_id}, {status: busy}, or {status: changed} when
-- the render printed another decision's fingerprint (nothing written).
-- ----------------------------------------------------------------------------
create or replace function app.quote_signed_pdf_write(p_quote_id uuid, p_org uuid, p_size bigint, p_sha256 text, p_name text,
                                                      p_path text, p_fingerprint text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
  v_block jsonb;
  v_file  public.files;
  v_sent  uuid;
  v_obj   record;
  v_path  text;
begin
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' or p_size is null or p_size < 1 or p_size > 26214400
     or coalesce(btrim(p_name), '') = '' or char_length(p_name) > 200 or p_name ~ '[/\\]' or lower(p_name) !~ '\.pdf$' then
    raise exception 'invalid PDF details' using errcode = '22023', hint = 'quote_pdf:invalid';
  end if;
  -- one render at a time per quote (the as-sent writer takes the same lock)
  perform pg_advisory_xact_lock(hashtextextended('quote_pdf:' || p_quote_id::text, 0));
  select * into v_quote from public.quotes q where q.organization_id = p_org and q.id = p_quote_id;
  if not found or v_quote.status <> 'accepted' or v_quote.customer_deleted_at is not null then
    perform app.quote_pdf_abandon(p_org, p_path);
    raise exception 'a signed PDF is made for an accepted quote' using errcode = 'P0001', hint = 'quote_pdf:not_accepted';
  end if;
  v_block := app.quote_signature_block(v_quote);
  if v_block is null then
    perform app.quote_pdf_abandon(p_org, p_path);
    raise exception 'a signed PDF is made for an accepted quote' using errcode = 'P0001', hint = 'quote_pdf:not_accepted';
  end if;
  -- the render printed this decision
  if p_fingerprint is distinct from v_block ->> 'fingerprint' then
    perform app.quote_pdf_abandon(p_org, p_path);
    return jsonb_build_object('status', 'changed');
  end if;
  if not app.org_has_feature(p_org, 'quotes') then
    perform app.quote_pdf_abandon(p_org, p_path);
    raise exception 'quotes are not in the plan' using errcode = 'P0001', hint = 'feature:quotes';
  end if;

  select * into v_file from public.files f
   where f.organization_id = p_org and f.quote_id = p_quote_id and f.quote_signed
     for update;
  if found and v_file.unconfirmed_since is null then
    -- kept once: a stale render that uploaded to its own path is not the file
    if p_path is distinct from v_file.storage_path then
      perform app.quote_pdf_abandon(p_org, p_path);
    end if;
    return jsonb_build_object('status', 'stored', 'file_id', v_file.id);
  end if;

  if v_file.id is null then
    select f.id into v_sent from public.files f
     where f.organization_id = p_org and f.quote_id = p_quote_id and f.quote_signed is null;
    -- the triggers set the path and no uploader, check the line and take the quota (files_quote_pdf)
    insert into public.files (organization_id, quote_id, quote_signed, previous_id, name, mime_type, size_bytes,
                              unconfirmed_since, sha256)
    values (p_org, p_quote_id, true, v_sent, btrim(p_name), 'application/pdf', p_size, now(), p_sha256)
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
    if p_path is distinct from v_file.storage_path then
      perform app.quote_pdf_abandon(p_org, p_path);
    end if;
    -- after two minutes without its object the row is taken over
    if coalesce(v_file.upload_checked_at, v_file.created_at) > now() - interval '2 minutes' then
      return jsonb_build_object('status', 'busy');
    end if;
  end if;

  v_path := p_org::text || '/' || gen_random_uuid()::text;
  update public.files f
     set storage_path = v_path, sha256 = p_sha256, size_bytes = p_size, name = btrim(p_name), uploaded_by = null,
         upload_checked_at = now()
   where f.organization_id = p_org and f.id = v_file.id;
  perform app.quote_pdf_abandon(p_org, v_file.storage_path);
  return jsonb_build_object('status', 'upload', 'path', v_path);
end;
$$;
revoke all on function app.quote_signed_pdf_write(uuid, uuid, bigint, text, text, text, text)
  from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- (1) The customer's route. The quote behind the token as quote_public_decide finds it: the link rule, the version the page
-- shows. Internal.
-- ----------------------------------------------------------------------------
create or replace function app.quote_signed_pdf_token_quote(p_token text) returns public.quotes
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_link app.quote_links;
  v_quote public.quotes;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_link from app.quote_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = v_link.organization_id and q.id = v_link.quote_id;
  if not found or not app.quote_link_usable(v_quote) then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  v_quote := app.quote_shown_version(v_quote);
  if v_quote.customer_deleted_at is not null then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  return v_quote;
end;
$$;
revoke all on function app.quote_signed_pdf_token_quote(text) from public, anon, authenticated, service_role;

-- What the route renders: {done} once a signed PDF is kept, {unavailable} while there is nothing to sign (not accepted, the
-- decision erased) or {rate_limited}; else the page's own answer (quote_public, no view counted) plus `signature`.
create or replace function public.quote_signed_pdf_public(p_token text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_quote public.quotes := app.quote_signed_pdf_token_quote(p_token);
  v_block jsonb;
  v_page  jsonb;
begin
  if v_quote.status <> 'accepted' then
    return jsonb_build_object('unavailable', true);
  end if;
  v_block := app.quote_signature_block(v_quote);
  if v_block is null then
    return jsonb_build_object('unavailable', true);
  end if;
  if app.quote_signed_pdf_done(v_quote) then
    return jsonb_build_object('done', true);
  end if;
  -- the document as the customer's page shows it; this read is not a view of the customer's
  perform set_config('app.quote_view_quiet', v_quote.id::text, true);
  v_page := public.quote_public(p_token);
  perform set_config('app.quote_view_quiet', '', true);
  if v_page ? 'rate_limited' then
    return jsonb_build_object('rate_limited', true);
  end if;
  if not (v_page ? 'quote') or v_page #>> '{quote,status}' is distinct from 'accepted' then
    return jsonb_build_object('unavailable', true);
  end if;
  return v_page || jsonb_build_object('signature', v_block);
end;
$$;
revoke all on function public.quote_signed_pdf_public(text) from public, anon, authenticated;
grant execute on function public.quote_signed_pdf_public(text) to service_role;

create or replace function public.quote_signed_pdf_public_store(p_token text, p_size bigint, p_sha256 text, p_name text,
                                                                p_path text default null, p_fingerprint text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_quote public.quotes := app.quote_signed_pdf_token_quote(p_token);
begin
  return app.quote_signed_pdf_write(v_quote.id, v_quote.organization_id, p_size, p_sha256, p_name, p_path, p_fingerprint);
end;
$$;
revoke all on function public.quote_signed_pdf_public_store(text, bigint, text, text, text, text) from public, anon, authenticated;
grant execute on function public.quote_signed_pdf_public_store(text, bigint, text, text, text, text) to service_role;

-- ----------------------------------------------------------------------------
-- (2) Staff. The person's right, asked with their own session; answers the signature block to render, or null
-- ----------------------------------------------------------------------------
create or replace function public.quote_signed_pdf_allowed(p_org uuid, p_quote uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
begin
  if p_org is null or p_quote is null or not app.can_write(p_org) then
    return null;
  end if;
  select * into v_quote from public.quotes q where q.organization_id = p_org and q.id = p_quote;
  if not found or v_quote.status <> 'accepted' or v_quote.customer_deleted_at is not null
     or not app.org_writable(p_org) or not app.org_has_feature(p_org, 'quotes')
     or not app.quote_editable(v_quote.organization_id, v_quote.deal_id, v_quote.contact_id)
     or app.quote_signed_pdf_done(v_quote) then
    return null;
  end if;
  return app.quote_signature_block(v_quote);
end;
$$;
revoke all on function public.quote_signed_pdf_allowed(uuid, uuid) from public, anon;
grant execute on function public.quote_signed_pdf_allowed(uuid, uuid) to authenticated;

create or replace function public.quote_signed_pdf_store(p_org uuid, p_quote uuid, p_user uuid, p_size bigint, p_sha256 text,
                                                         p_name text, p_path text default null, p_fingerprint text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
begin
  select * into v_quote from public.quotes q where q.organization_id = p_org and q.id = p_quote;
  if not found or not app.quote_pdf_user_may(p_org, p_user, v_quote.deal_id, v_quote.contact_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return app.quote_signed_pdf_write(p_quote, p_org, p_size, p_sha256, p_name, p_path, p_fingerprint);
end;
$$;
revoke all on function public.quote_signed_pdf_store(uuid, uuid, uuid, bigint, text, text, text, text) from public, anon, authenticated;
grant execute on function public.quote_signed_pdf_store(uuid, uuid, uuid, bigint, text, text, text, text) to service_role;

-- ----------------------------------------------------------------------------
-- 021015's public.quote_pdf_store, on the quote's PDF as sent only (the signed version is not its row)
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
  -- QUO-09: the PDF as sent (a signed version after it is written by app.quote_signed_pdf_write only)
  select * into v_file from public.files f
   where f.organization_id = p_org and f.quote_id = p_quote and f.quote_signed is null
     for update;
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

-- ----------------------------------------------------------------------------
-- 020995's public.quote_public_pdf, serving the newest confirmed version
-- ----------------------------------------------------------------------------
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
  -- QUO-09 (answer (33) ב): the newest confirmed, fingerprinted version: the signed PDF once it is kept, else the one as sent
  select * into v_file from public.files f
   where f.organization_id = v_shown.organization_id and f.quote_id = v_shown.id
     and f.unconfirmed_since is null and f.sha256 is not null
   order by (f.quote_signed is true) desc, f.created_at desc, f.id desc
   limit 1;
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
-- 021117's public.quote_public_version: pdf_as_sent only while no signed PDF is kept
-- ----------------------------------------------------------------------------
create or replace function public.quote_public_version(p_token text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_link app.quote_links;
  v_quote public.quotes;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_link from app.quote_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = v_link.organization_id and q.id = v_link.quote_id;
  -- owner, 19 October 2026: the link of a sent quote never answers not found (app.quote_link_usable)
  if not found or not app.quote_link_usable(v_quote) then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  if v_link.window_started_at > now() - interval '10 minutes' and v_link.window_count > 120 then
    return jsonb_build_object('rate_limited', true);
  end if;
  v_quote := app.quote_shown_version(v_quote);
  if v_quote.customer_deleted_at is not null then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  -- QUO-08: an accepted quote whose stored PDF (as sent) differs from what was accepted says so; every other answer is as before
  -- QUO-09: once the signed PDF is kept the customer downloads that one, and the label goes
  if v_quote.status = 'accepted'
     and not app.quote_signed_pdf_done(v_quote)
     and exists (select 1 from public.quote_decisions d
                  where d.organization_id = v_quote.organization_id and d.quote_id = v_quote.id
                    and d.decision = 'accepted' and d.accepted_net_total_agorot is not null
                    and d.accepted_net_total_agorot is distinct from d.sent_net_total_agorot) then
    return jsonb_build_object('number', v_quote.number_display, 'fingerprint', null, 'pdf_as_sent', true);
  end if;
  -- a fingerprint only for an open newest version: only that one is decided
  return jsonb_build_object(
    'number', v_quote.number_display,
    'fingerprint', case when app.quote_offer_open(v_quote) then app.quote_fingerprint(v_quote) end);
end;
$$;
revoke all on function public.quote_public_version(text) from public, anon, authenticated;
grant execute on function public.quote_public_version(text) to service_role;

-- ----------------------------------------------------------------------------
-- 020455's app.quote_mark_viewed, skipping the server's own read for the signed PDF
-- ----------------------------------------------------------------------------
create or replace function app.quote_mark_viewed(p_quote public.quotes) returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_first public.quotes;
begin
  if p_quote.id is null then
    return false;
  end if;
  -- QUO-09 signed PDF: the server reading the customer's page to render it (public.quote_signed_pdf_public) is not a view
  if current_setting('app.quote_view_quiet', true) = p_quote.id::text then
    return false;
  end if;
  insert into public.quote_views as v (organization_id, quote_id)
  values (p_quote.organization_id, p_quote.id)
  on conflict (organization_id, quote_id) do update
    set last_viewed_at = now(), view_count = v.view_count + 1;

  -- the first view of a sent quote: once, even when two views arrive together
  update public.quotes q set status = 'viewed'
   where q.organization_id = p_quote.organization_id and q.id = p_quote.id and q.status = 'sent'
  returning q.* into v_first;
  if v_first.id is null then
    return false;
  end if;

  -- RVW-34: the owner, else the record's current owner, else the owners and admins (app.quote_notice_recipients)
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select v_first.organization_id, r.user_id, 'quote_viewed',
         'הלקוח פתח את הצעת המחיר' || coalesce(' ' || v_first.number_display, ''),
         -- no personal data: a later privacy erasure does not reach notification bodies
         nullif(btrim(coalesce(v_first.title, '')), ''),
         'quote', v_first.id
    from app.quote_notice_recipients(v_first) r(user_id);
  return true;
end;
$$;
revoke all on function app.quote_mark_viewed(public.quotes) from public, anon, authenticated, service_role;
