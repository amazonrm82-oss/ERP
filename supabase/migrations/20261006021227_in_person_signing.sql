-- =============================================================================
-- SGN-07: in-person signing. The customer signs with a finger on the rep's device, on a document for signature (SGN-02) or
-- on a quote (QUO-09); it is recorded that the signing was face to face, and which rep was present.
-- =============================================================================
-- Owner, 11 November 2026, answer (276) א (DECISIONS.md, CLAUDE.md "SGN-07"): a rep's own session may trigger the signed-PDF
-- writer, under SGN-02's conditions (191): the session is checked first, only someone who may send the document may do it,
-- and the signing is recorded with the rep's identity and device (the browser's user agent only; no other device id, and
-- no IP: the rep's address is not the customer's).
--
-- * The signature rows say so: signature_signatures.in_person / in_person_by and quote_decisions.in_person / in_person_by
--   (null | true, and the rep's user id; both or neither, constraints *_in_person_shape). Written only by the two functions
--   below; read as before (owners and admins only, the tables' select policies are unchanged). The user agent is the
--   existing user_agent column (the rep's device); ip stays empty.
-- * A document for signature: public.signature_in_person_sign(org, doc, fingerprint, ...) (security definer, authenticated
--   only). The rep's session first: app.signature_managed_document (whoever may edit the live record in a writable business
--   with the `signatures` key, the same right that sends a document, refuses everyone else with 42501). Then exactly what
--   public.signature_public_sign does (021212, kept in step): the link row's signing window counts the try (10 in 10
--   minutes, shared with the customer's link), the document locked, already_signed | closed | changed | invalid, the same
--   values checked, one signature, signed_token_hash set (the customer's own link then downloads the signed PDF, as after a
--   signature through it), `people` widened, the timeline entry kind signature_signed (body "הלקוח חתם על המסמך במקום: "
--   and the title, by the rep), the "signed" notice to the same recipients without the rep (the document's title only).
--   Review (high): the notice keeps the public path's title "מסמך נחתם בקישור", because both privacy erasures
--   (app.signature_documents_erase_named / app.signature_documents_erase, 021216) find the "signed" notices by that title;
--   "in person" lives in the timeline entry, the signature row and the PDF. A document without a link row (none today: the
--   send always issues one) answers closed, so the try counter always applies. One audit entry, action
--   in_person_signature, ids and codes only.
-- * A quote: public.quote_in_person_open(org, quote) answers the state and, while open, the fingerprint the page signs; and
--   public.quote_in_person_accept(org, quote, ...) accepts it. Rights first: app.can_write, app.org_writable, the `quotes`
--   key and app.quote_editable (the right that sends a quote, quote_send). The quote must be the version its link shows
--   (app.quote_shown_version) and open (app.quote_offer_open, app.quote_link_usable), and it must have a live customer link
--   (app.quote_links with a token; review (low): the link row carries the try counter, so without one the state is no_link
--   and accepting answers closed). Then the accepted branch of
--   public.quote_public_answer (021117, kept in step; test 341 compares both paths' rows): the decide window of the link
--   row when there is one, the lock, the optional lines by place, the counted totals and the shown total, the decision,
--   the lines' choice, the status, app.quote_accept_deal, the notice (without the rep, title "הצעת מחיר אושרה במקום: ").
--   The writes run with the JWT claims put aside and restored (as AUT-02's server copies), so every quote trigger sees the
--   same server write as the customer's acceptance (app.quotes_check recomputes the accepted totals only while auth.uid() is
--   null). One audit entry by the rep, action in_person_signature.
-- * The signed PDF: public.signature_in_person_pdf_allowed / public.quote_in_person_pdf_allowed (security definer,
--   authenticated, the rep's session) answer what to render only to the rep who was present, within an hour of the signing,
--   who may still manage the document; then the existing writers public.signature_pdf_store and
--   public.quote_signed_pdf_store (service_role, no new service-key function) also write for that rep: each is its latest
--   body (021212, 021122) with one more allowed user, checked again in the database for a named user
--   (app.signature_in_person_rep, app.quote_in_person_rep: an active non-viewer member, the decision's in_person_by, within
--   the hour, and app.can_edit_record's rule for that user: app.signature_pdf_user_may (new) / app.quote_pdf_user_may).
--   Owners and admins keep the staff button as before.
-- * The signed PDF prints that the signing was in person and the rep's name: app.signature_pdf_source (021216's body) and
--   app.quote_signature_block (021122's body) add `in_person` and `in_person_by_name` (profiles.full_name), nothing else.
-- Redefined from their latest bodies plus the marked lines only: public.signature_pdf_store (021212),
-- public.quote_signed_pdf_store (021122), app.signature_pdf_source (021216), app.quote_signature_block (021122).
-- Every statement is safe to run twice. No statement starts with drop, no row removal.

-- ----------------------------------------------------------------------------
-- The columns
-- ----------------------------------------------------------------------------
alter table public.signature_signatures add column if not exists in_person boolean;
alter table public.signature_signatures add column if not exists in_person_by uuid;
alter table public.quote_decisions add column if not exists in_person boolean;
alter table public.quote_decisions add column if not exists in_person_by uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'signature_signatures_in_person_shape') then
    alter table public.signature_signatures add constraint signature_signatures_in_person_shape
      check ((in_person is null and in_person_by is null) or (in_person and in_person_by is not null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'quote_decisions_in_person_shape') then
    alter table public.quote_decisions add constraint quote_decisions_in_person_shape
      check ((in_person is null and in_person_by is null) or (in_person and in_person_by is not null));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- A document for signature, signed in person
-- ----------------------------------------------------------------------------
create or replace function public.signature_in_person_sign(
  p_org uuid, p_doc uuid, p_fingerprint text, p_signer_name text, p_id_number text default null,
  p_signature_kind text default null, p_signature_image text default null, p_wording_version text default null,
  p_agreed boolean default false, p_user_agent text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  -- the rep's session first: the right that sends the document (42501 otherwise)
  v_doc public.signature_documents := app.signature_managed_document(p_org, p_doc);
  v_tries integer;
  v_name text := nullif(btrim(coalesce(p_signer_name, '')), '');
  v_id text := nullif(regexp_replace(coalesce(p_id_number, ''), '[^0-9]', '', 'g'), '');
  v_record jsonb;
  v_rep uuid := auth.uid();
begin
  if v_rep is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- the signing tries of the document's link (10 in 10 minutes), shared with the customer's page
  update app.signature_links l
     set sign_window_started_at = case when l.sign_window_started_at > now() - interval '10 minutes' then l.sign_window_started_at else now() end,
         sign_count = case when l.sign_window_started_at > now() - interval '10 minutes' then l.sign_count + 1 else 1 end
   where l.document_id = v_doc.id
  returning l.sign_count into v_tries;
  -- review (low): no link row, no counter: never signed without one
  if v_tries is null then
    return jsonb_build_object('status', 'closed');
  end if;
  if v_tries > 10 then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  -- locked against a second signature and a cancel in parallel (public.signature_public_sign's checks, kept in step)
  select * into v_doc from public.signature_documents d where d.organization_id = v_doc.organization_id and d.id = v_doc.id for update;
  if v_doc.status = 'signed' then
    return jsonb_build_object('status', 'already_signed');
  end if;
  if v_doc.status not in ('sent', 'viewed') or v_doc.erased_at is not null
     or (v_doc.expires_at is not null and v_doc.expires_at <= now()) then
    return jsonb_build_object('status', 'closed');
  end if;
  if p_fingerprint is distinct from v_doc.content_sha256 or v_doc.content_sha256 is distinct from app.signature_fingerprint(v_doc) then
    return jsonb_build_object('status', 'changed');
  end if;
  if not coalesce(p_agreed, false) or v_name is null or char_length(v_name) not between 2 and 120
     or not exists (select 1 from app.signature_wording_versions w where w.version = p_wording_version)
     or p_signature_kind is null or p_signature_kind not in ('drawn', 'typed')
     or (p_signature_kind = 'drawn' and (p_signature_image is null or char_length(p_signature_image) > 300000
                                         or p_signature_image !~ '^data:image/png;base64,[A-Za-z0-9+/]+=*$'))
     or (v_id is not null and not app.valid_israeli_id(v_id)) then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- the rep's identity and device (the user agent), never an IP
  insert into public.signature_signatures (organization_id, document_id, signer_name, signer_id_number, signature_kind,
                                           signature_image, wording_version, content_sha256, ip, user_agent,
                                           in_person, in_person_by)
  values (v_doc.organization_id, v_doc.id, v_name, v_id, p_signature_kind,
          case when p_signature_kind = 'drawn' then p_signature_image end, p_wording_version, v_doc.content_sha256,
          null, left(nullif(btrim(coalesce(p_user_agent, '')), ''), 500), true, v_rep);
  update app.signature_links l set signed_token_hash = l.token_hash where l.document_id = v_doc.id;
  update public.signature_documents d
     set status = 'signed', signed_at = now(),
         people = (select coalesce(array_agg(distinct x), '{}') from unnest(d.people || app.signature_people(d)) x)
   where d.organization_id = v_doc.organization_id and d.id = v_doc.id
  returning * into v_doc;
  perform app.signature_timeline(v_doc, 'signature_signed', 'הלקוח חתם על המסמך במקום: ' || v_doc.title, v_rep);

  -- the sender and the record's owner (active, not viewers); else the active owners and admins; never the rep who was
  -- there. The title only.
  v_record := app.signature_record_row(v_doc.organization_id, app.signature_record_type(v_doc), app.signature_record_id(v_doc));
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select v_doc.organization_id, r.user_id, 'system', 'מסמך נחתם בקישור', v_doc.title,
         app.signature_record_type(v_doc), app.signature_record_id(v_doc)
    from (select m.user_id from public.memberships m
           where m.organization_id = v_doc.organization_id and m.status = 'active' and m.role <> 'viewer'
             and m.user_id in (v_doc.sent_by, (v_record ->> 'owner_id')::uuid)
          union
          select m.user_id from public.memberships m
           where m.organization_id = v_doc.organization_id and m.status = 'active' and m.role in ('owner', 'admin')
             and not exists (select 1 from public.memberships o
                              where o.organization_id = v_doc.organization_id and o.status = 'active' and o.role <> 'viewer'
                                and o.user_id in (v_doc.sent_by, (v_record ->> 'owner_id')::uuid))) r
   where r.user_id <> v_rep;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (v_doc.organization_id, v_rep, 'in_person_signature', 'signature_documents', v_doc.id,
          jsonb_build_object('status', 'signed', 'in_person', true, 'record_type', app.signature_record_type(v_doc)));
  return jsonb_build_object('status', 'signed');
end;
$$;
revoke all on function public.signature_in_person_sign(uuid, uuid, text, text, text, text, text, text, boolean, text) from public, anon;
grant execute on function public.signature_in_person_sign(uuid, uuid, text, text, text, text, text, text, boolean, text) to authenticated;

-- the rep who was present, within the hour, for a named user (the service_role writer checks it again)
create or replace function app.signature_in_person_rep(p_org uuid, p_doc uuid, p_user uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_user is not null and exists (
    select 1 from public.signature_signatures s
     where s.organization_id = p_org and s.document_id = p_doc and s.in_person and s.in_person_by = p_user
       and s.erased_at is null and s.signed_at > now() - interval '1 hour')
$$;
revoke all on function app.signature_in_person_rep(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- app.can_edit_record's rule for a named user on a document's live record (app.quote_pdf_user_may's copy; keep in step)
create or replace function app.signature_pdf_user_may(p_org uuid, p_user uuid, p_doc uuid) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_role  public.membership_role;
  v_doc   public.signature_documents;
  v_record jsonb;
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
  select * into v_doc from public.signature_documents d where d.organization_id = p_org and d.id = p_doc;
  if not found then
    return false;
  end if;
  v_record := app.signature_record_row(p_org, app.signature_record_type(v_doc), app.signature_record_id(v_doc));
  if v_record is null or (v_record ->> 'deleted_at') is not null then
    return false;
  end if;
  v_owner := (v_record ->> 'owner_id')::uuid;
  v_team := (v_record ->> 'team_id')::uuid;
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
revoke all on function app.signature_pdf_user_may(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- the rep's session: what to render, only to the rep who was present, within the hour; null once the PDF is kept
create or replace function public.signature_in_person_pdf_allowed(p_org uuid, p_doc uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_doc public.signature_documents := app.signature_managed_document(p_org, p_doc);
begin
  if not app.signature_in_person_rep(p_org, v_doc.id, auth.uid()) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if app.signature_pdf_done(v_doc) then
    return null;
  end if;
  return app.signature_pdf_source(v_doc);
end;
$$;
revoke all on function public.signature_in_person_pdf_allowed(uuid, uuid) from public, anon;
grant execute on function public.signature_in_person_pdf_allowed(uuid, uuid) to authenticated;

-- public.signature_pdf_store of 021212 with one more allowed user (marked)
create or replace function public.signature_pdf_store(p_org uuid, p_doc uuid, p_user uuid, p_size bigint, p_sha256 text,
                                                      p_path text default null, p_fingerprint text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  -- written for an active owner or admin of a writable business with the key only
  if not (exists (select 1 from public.memberships m
                   where m.organization_id = p_org and m.user_id = p_user and m.status = 'active' and m.role in ('owner', 'admin'))
          -- SGN-07 (276) א: or the rep who was present at an in-person signing, within the hour, who may still edit the record
          or (app.signature_in_person_rep(p_org, p_doc, p_user) and app.signature_pdf_user_may(p_org, p_user, p_doc)))
     or not exists (select 1 from public.signature_documents d where d.organization_id = p_org and d.id = p_doc)
     or not app.org_writable(p_org) or not app.org_has_feature(p_org, 'signatures') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return app.signature_pdf_write(p_doc, p_org, p_path, p_size, p_sha256, p_fingerprint);
end;
$$;
revoke all on function public.signature_pdf_store(uuid, uuid, uuid, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.signature_pdf_store(uuid, uuid, uuid, bigint, text, text, text) to service_role;

-- app.signature_pdf_source of 021216 with the in-person line (marked)
create or replace function app.signature_pdf_source(p_doc public.signature_documents) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_sig public.signature_signatures;
  v_org public.organizations;
  v_settings public.org_document_settings;
begin
  if p_doc.status <> 'signed' or p_doc.erased_at is not null then
    return null;
  end if;
  select * into v_sig from public.signature_signatures s
   where s.organization_id = p_doc.organization_id and s.document_id = p_doc.id and s.erased_at is null;
  if not found then
    return null;
  end if;
  select * into v_org from public.organizations o where o.id = p_doc.organization_id;
  select * into v_settings from public.org_document_settings s where s.organization_id = p_doc.organization_id;
  return jsonb_build_object(
    -- (234) ב: a signed document whose text an erasure changed prints the line saying so
    'document', jsonb_build_object('title', p_doc.title, 'body', p_doc.body, 'sent_at', p_doc.sent_at,
                                   'text_erased', p_doc.text_erased_at is not null,
                                   -- delta review: the text as it is now, passed back as p_fingerprint
                                   'fingerprint', app.signature_fingerprint(p_doc)),
    'business', jsonb_build_object(
      'name', coalesce(nullif(btrim(v_settings.legal_name), ''), v_org.name),
      'tax_id', v_settings.tax_id,
      'phone', coalesce(nullif(btrim(v_settings.phone), ''), nullif(btrim(v_org.phone), '')),
      'email', v_settings.email),
    'brand', jsonb_build_object('logo', v_org.logo_path, 'color', v_org.brand_color),
    'signature', jsonb_build_object(
      'signer_name', v_sig.signer_name,
      'id_number', v_sig.signer_id_number,
      'kind', v_sig.signature_kind,
      'image', case when v_sig.signature_kind = 'drawn' then v_sig.signature_image end,
      'signed_at', v_sig.signed_at,
      'time_zone', app.intake_zone(v_org.timezone),
      'wording_version', v_sig.wording_version,
      -- review 5: the registered text of that version (null for a version not registered)
      'wording', (select w.wording from app.signature_wording_versions w where w.version = v_sig.wording_version),
      'fingerprint', v_sig.content_sha256,
      -- SGN-07: signed face to face, and the rep who was present
      'in_person', coalesce(v_sig.in_person, false),
      'in_person_by_name', case when v_sig.in_person then
        (select nullif(btrim(p.full_name), '') from public.profiles p where p.id = v_sig.in_person_by) end));
end;
$$;
revoke all on function app.signature_pdf_source(public.signature_documents) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- A quote, accepted in person
-- ----------------------------------------------------------------------------
-- the rep's right (quote_send's: whoever may edit the quote's live parent, in a writable business with the key), or 42501
create or replace function app.quote_in_person_quote(p_org uuid, p_quote uuid) returns public.quotes
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
begin
  select * into v_quote from public.quotes q where q.organization_id = p_org and q.id = p_quote;
  if not found or auth.uid() is null or not app.can_write(p_org)
     or not app.quote_editable(v_quote.organization_id, v_quote.deal_id, v_quote.contact_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.org_writable(p_org) then
    raise exception 'the business is read only' using errcode = '42501';
  end if;
  if not app.org_has_feature(p_org, 'quotes') then
    raise exception 'quotes are not in this plan' using errcode = 'P0001', hint = 'feature:quotes';
  end if;
  return v_quote;
end;
$$;
revoke all on function app.quote_in_person_quote(uuid, uuid) from public, anon, authenticated, service_role;

-- open (the version the link shows, open for an answer) | superseded | decided | closed | no_link (no live customer link)
create or replace function app.quote_in_person_state(p_quote public.quotes) returns text
language sql stable security definer
set search_path = ''
as $$
  select case
    when p_quote.status in ('accepted', 'rejected') then 'decided'
    when (app.quote_shown_version(p_quote)).id is distinct from p_quote.id then 'superseded'
    when not app.quote_link_usable(p_quote) or not app.quote_offer_open(p_quote) then 'closed'
    when not exists (select 1 from app.quote_links l
                      where l.organization_id = p_quote.organization_id and l.quote_id = p_quote.id
                        and l.token_hash is not null) then 'no_link'
    else 'open'
  end
$$;
revoke all on function app.quote_in_person_state(public.quotes) from public, anon, authenticated, service_role;

create or replace function public.quote_in_person_open(p_org uuid, p_quote uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_quote public.quotes := app.quote_in_person_quote(p_org, p_quote);
  v_state text := app.quote_in_person_state(v_quote);
begin
  return jsonb_build_object('state', v_state,
                            'fingerprint', case when v_state = 'open' then app.quote_fingerprint(v_quote) end);
end;
$$;
revoke all on function public.quote_in_person_open(uuid, uuid) from public, anon;
grant execute on function public.quote_in_person_open(uuid, uuid) to authenticated;

-- public.quote_public_answer's accepted branch (021117), by the rep's session for the quote itself (kept in step)
create or replace function public.quote_in_person_accept(
  p_org uuid, p_quote uuid, p_fingerprint text,
  p_signer_name text default null, p_id_number text default null,
  p_signature_kind text default null, p_signature_image text default null,
  p_wording_version text default null, p_agreed boolean default false, p_user_agent text default null,
  p_optional_keys integer[] default null, p_accepted_total_agorot bigint default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_quote public.quotes := app.quote_in_person_quote(p_org, p_quote);
  v_rep uuid := auth.uid();
  v_tries integer;
  v_state text;
  v_name text := nullif(btrim(coalesce(p_signer_name, '')), '');
  v_id text := nullif(regexp_replace(coalesce(p_id_number, ''), '[^0-9]', '', 'g'), '');
  v_deal_note text;
  v_choice uuid[];
  v_matched integer;
  v_totals jsonb;
  v_claims text;
  v_claim_sub text;
begin
  -- the decide window of the quote's live link (10 tries in 10 minutes, shared with the customer's page); review (low): no
  -- live link, no counter, so nothing is accepted without one
  update app.quote_links l
     set decide_window_started_at = case when l.decide_window_started_at > now() - interval '10 minutes' then l.decide_window_started_at else now() end,
         decide_count = case when l.decide_window_started_at > now() - interval '10 minutes' then l.decide_count + 1 else 1 end
   where l.quote_id = v_quote.id and l.organization_id = v_quote.organization_id and l.token_hash is not null
  returning l.decide_count into v_tries;
  if v_tries is null then
    return jsonb_build_object('status', 'closed');
  end if;
  if v_tries > 10 then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  -- locked against a second decision in parallel; then the same states as the customer's page
  select * into v_quote from public.quotes q where q.organization_id = v_quote.organization_id and q.id = v_quote.id for update;
  v_state := app.quote_in_person_state(v_quote);
  if v_state = 'decided' then
    return jsonb_build_object('status', 'already_decided', 'decision', v_quote.status);
  end if;
  if v_state = 'superseded' then
    return jsonb_build_object('status', 'changed');
  end if;
  if v_state <> 'open' then
    return jsonb_build_object('status', 'closed');
  end if;
  if p_fingerprint is distinct from app.quote_fingerprint(v_quote) then
    return jsonb_build_object('status', 'changed');
  end if;

  if not coalesce(p_agreed, false) or v_name is null or char_length(v_name) not between 2 and 120
     or coalesce(p_wording_version, '') !~ '^[a-z0-9-]{1,40}$'
     or p_signature_kind is null or p_signature_kind not in ('drawn', 'typed')
     or (p_signature_kind = 'drawn' and (p_signature_image is null or char_length(p_signature_image) > 300000
                                         or p_signature_image !~ '^data:image/png;base64,[A-Za-z0-9+/]+=*$'))
     or (v_id is not null and not app.valid_israeli_id(v_id)) then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- QUO-08: the optional lines ticked, by their place in the page's list (as public.quote_public_answer)
  if p_optional_keys is null then
    if p_accepted_total_agorot is not null then
      return jsonb_build_object('status', 'invalid');
    end if;
    select coalesce(array_agg(l.id order by l.position, l.id), '{}') into v_choice
      from public.quote_lines l
     where l.organization_id = v_quote.organization_id and l.quote_id = v_quote.id
       and l.kind = 'item' and l.is_optional and l.optional_selected;
  else
    if p_accepted_total_agorot is null or cardinality(p_optional_keys) > 200 or array_position(p_optional_keys, null) is not null
       or cardinality(p_optional_keys) <> (select count(distinct k) from unnest(p_optional_keys) k) then
      return jsonb_build_object('status', 'invalid');
    end if;
    select coalesce(array_agg(o.id order by o.place), '{}'), count(*) into v_choice, v_matched
      from (select l.id, l.kind, l.is_optional, row_number() over (order by l.position, l.id) as place
              from public.quote_lines l
             where l.organization_id = v_quote.organization_id and l.quote_id = v_quote.id) o
     where o.place = any (p_optional_keys) and o.kind = 'item' and o.is_optional;
    if v_matched <> cardinality(p_optional_keys) then
      return jsonb_build_object('status', 'invalid');
    end if;
  end if;
  begin
    v_totals := app.quote_counted_totals(v_quote, v_quote.vat_rate_bp, v_choice);
  exception when sqlstate '22023' then
    return jsonb_build_object('status', 'invalid');
  end;
  if p_accepted_total_agorot is not null and p_accepted_total_agorot is distinct from (v_totals ->> 'total_agorot')::bigint then
    return jsonb_build_object('status', 'changed');
  end if;

  -- the writes below are the server's, as the customer's acceptance (the quote triggers judge a write with no person)
  v_claims := current_setting('request.jwt.claims', true);
  v_claim_sub := current_setting('request.jwt.claim.sub', true);
  if v_claims is not null then
    perform set_config('request.jwt.claims', '', true);
  end if;
  if v_claim_sub is not null then
    perform set_config('request.jwt.claim.sub', '', true);
  end if;

  -- the rep's identity and device (the user agent), never an IP
  insert into public.quote_decisions (organization_id, quote_id, decision, signer_name, signer_id_number, signature_kind,
                                      signature_image, wording_version, content_sha256, ip, user_agent,
                                      optional_line_ids, choice_sha256, sent_net_total_agorot, sent_total_agorot,
                                      accepted_subtotal_agorot, accepted_discount_total_agorot, accepted_net_total_agorot,
                                      accepted_vat_agorot, accepted_total_agorot, in_person, in_person_by)
  values (v_quote.organization_id, v_quote.id, 'accepted', v_name, v_id, p_signature_kind,
          case when p_signature_kind = 'drawn' then p_signature_image end, p_wording_version, p_fingerprint,
          null, left(nullif(btrim(coalesce(p_user_agent, '')), ''), 500),
          v_choice, app.quote_choice_fingerprint(p_fingerprint, v_choice), v_quote.net_total_agorot, v_quote.total_agorot,
          (v_totals ->> 'subtotal_agorot')::bigint, (v_totals ->> 'document_discount_agorot')::bigint,
          (v_totals ->> 'net_total_agorot')::bigint, (v_totals ->> 'vat_agorot')::bigint, (v_totals ->> 'total_agorot')::bigint,
          true, v_rep);

  perform set_config('app.quote_accept_choice', v_quote.id::text, true);
  update public.quote_lines l
     set optional_selected = (l.id = any (v_choice))
   where l.organization_id = v_quote.organization_id and l.quote_id = v_quote.id
     and l.kind = 'item' and l.is_optional and l.optional_selected is distinct from (l.id = any (v_choice));
  update public.quotes q set status = 'accepted'
   where q.organization_id = v_quote.organization_id and q.id = v_quote.id;
  perform set_config('app.quote_accept_choice', '', true);
  select * into v_quote from public.quotes q where q.organization_id = v_quote.organization_id and q.id = v_quote.id;

  -- QUO-13: the deal of an accepted quote, by the business's setting; never fails the decision
  begin
    v_deal_note := app.quote_accept_deal(v_quote);
  exception when others then
    raise warning 'QUO-13: the deal step of quote % failed: % (%)', v_quote.id, sqlerrm, sqlstate;
    v_deal_note := 'לא הצלחנו לטפל בעסקה של ההצעה. אפשר להעביר אותה לזכייה מדף ההצעה.';
  end;

  if v_claims is not null then
    perform set_config('request.jwt.claims', v_claims, true);
  end if;
  if v_claim_sub is not null then
    perform set_config('request.jwt.claim.sub', v_claim_sub, true);
  end if;

  -- the quote's owner hears of it, never the rep who was there: number and title, no amounts
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select v_quote.organization_id, r.user_id, 'quote',
         left('הצעת מחיר אושרה במקום: ' || v_quote.title, 200),
         nullif(concat_ws(' · ', case when v_quote.number_display is not null then 'הצעה ' || v_quote.number_display end, v_deal_note), ''),
         'quote', v_quote.id
    from app.quote_notice_recipients(v_quote) r(user_id)
   where r.user_id <> v_rep;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (v_quote.organization_id, v_rep, 'in_person_signature', 'quotes', v_quote.id,
          jsonb_build_object('status', 'accepted', 'in_person', true));
  return jsonb_build_object('status', 'accepted');
end;
$$;
revoke all on function public.quote_in_person_accept(uuid, uuid, text, text, text, text, text, text, boolean, text, integer[], bigint) from public, anon;
grant execute on function public.quote_in_person_accept(uuid, uuid, text, text, text, text, text, text, boolean, text, integer[], bigint) to authenticated;

-- the rep who was present, within the hour, for a named user
create or replace function app.quote_in_person_rep(p_org uuid, p_quote uuid, p_user uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_user is not null and exists (
    select 1 from public.quote_decisions d
     where d.organization_id = p_org and d.quote_id = p_quote and d.decision = 'accepted' and d.in_person
       and d.in_person_by = p_user and d.erased_at is null and d.decided_at > now() - interval '1 hour')
$$;
revoke all on function app.quote_in_person_rep(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- the rep's session: the signature block to render, only to the rep who was present, within the hour (as
-- public.quote_signed_pdf_allowed for owners and admins); null once kept
create or replace function public.quote_in_person_pdf_allowed(p_org uuid, p_quote uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_quote public.quotes := app.quote_in_person_quote(p_org, p_quote);
begin
  if not app.quote_in_person_rep(p_org, v_quote.id, auth.uid()) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_quote.status <> 'accepted' or v_quote.customer_deleted_at is not null or app.quote_signed_pdf_done(v_quote) then
    return null;
  end if;
  return app.quote_signature_block(v_quote);
end;
$$;
revoke all on function public.quote_in_person_pdf_allowed(uuid, uuid) from public, anon;
grant execute on function public.quote_in_person_pdf_allowed(uuid, uuid) to authenticated;

-- public.quote_signed_pdf_store of 021122 with one more allowed user (marked)
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
  -- review (high): written for an active owner or admin only, who may also edit the quote (app.quote_pdf_user_may)
  if not found
     or not (exists (select 1 from public.memberships m
                      where m.organization_id = p_org and m.user_id = p_user and m.status = 'active' and m.role in ('owner', 'admin'))
             -- SGN-07 (276) א: or the rep who was present at an in-person acceptance, within the hour
             or app.quote_in_person_rep(p_org, p_quote, p_user))
     or not app.quote_pdf_user_may(p_org, p_user, v_quote.deal_id, v_quote.contact_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return app.quote_signed_pdf_write(p_quote, p_org, p_size, p_sha256, p_name, p_path, p_fingerprint);
end;
$$;
revoke all on function public.quote_signed_pdf_store(uuid, uuid, uuid, bigint, text, text, text, text) from public, anon, authenticated;
grant execute on function public.quote_signed_pdf_store(uuid, uuid, uuid, bigint, text, text, text, text) to service_role;

-- app.quote_signature_block of 021122 with the in-person line (marked)
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
           'fingerprint', coalesce(d.choice_sha256, d.content_sha256),
           -- SGN-07: signed face to face, and the rep who was present
           'in_person', coalesce(d.in_person, false),
           'in_person_by_name', case when d.in_person then
             (select nullif(btrim(p.full_name), '') from public.profiles p where p.id = d.in_person_by) end)
    from public.quote_decisions d
    join public.organizations o on o.id = d.organization_id
   where d.organization_id = p_quote.organization_id and d.quote_id = p_quote.id
     and d.decision = 'accepted' and d.erased_at is null
$$;
revoke all on function app.quote_signature_block(public.quotes) from public, anon, authenticated, service_role;
