-- =============================================================================
-- A signature is accepted only on the agreement's own text (FXS-09)
-- =============================================================================
-- Before: public.sign_agreement() stored whatever documents the caller sent, so a direct call with the right
-- version and another text was recorded as signed.
-- Now: app.agreement_texts keeps the SHA-256 of every document text that may be signed, per version and document
-- (slug). sign_agreement() refuses (P0001, hint 'agreement:changed') a version with no registered texts, and
-- documents that are not exactly one of each registered slug of that version, each carrying only slug, title,
-- version and text (strings), with the version signed and a registered fingerprint.
-- * The fingerprint of a document is app.agreement_fingerprint(title, text) = sha256(hex(sha256(title)) ||
--   hex(sha256(text))), UTF-8 throughout: two fixed-length digests, so no part of the text can move into the title or
--   back without changing it. The app's side is fingerprintParts() in src/features/legal/fingerprint.ts over
--   agreementSnapshot(); tests/db/127 hashes the app's current texts and requires them here, so a changed text with no
--   migration fails the tests.
-- * A changed wording is a new LEGAL_VERSION (owner rule): a migration adds the new version's three rows. Filling
--   the owner's details into a draft keeps the version (owner, 12 October 2026): a migration adds the filled text's
--   rows under the same version (tests/unit/legal-fingerprint.test.ts tells the two apart by a template with the
--   details masked). Rows are never changed or removed, so the code still running during a deploy keeps signing.
-- * Existing signatures are untouched; this only checks new ones.
-- Every statement is safe to run twice. No drops, no row removal.

create table if not exists app.agreement_texts (
  version    text not null check (char_length(version) between 1 and 40),
  slug       text not null check (slug ~ '^[a-z]{1,40}$'),
  text_hash  text not null check (text_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (version, slug, text_hash)
);
-- schema app: RLS on, no policies, no client grants (read only by sign_agreement, security definer)
alter table app.agreement_texts enable row level security;
revoke all on app.agreement_texts from public, anon, authenticated;

-- The fingerprint of one document (immutable; internal: no grants, read by sign_agreement)
create or replace function app.agreement_fingerprint(p_title text, p_text text) returns text
language sql immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(
           encode(sha256(convert_to(p_title, 'UTF8')), 'hex') || encode(sha256(convert_to(p_text, 'UTF8')), 'hex'),
           'UTF8')), 'hex');
$$;
revoke all on function app.agreement_fingerprint(text, text) from public, anon, authenticated;

-- LEGAL_VERSION 2026-10-13: terms, privacy, dpa (interim texts, src/features/legal/documents.ts)
insert into app.agreement_texts (version, slug, text_hash) values
  ('2026-10-13', 'terms', '17b01a3656254a7389ab6e6f687b41249483d1f2afce060648ae21abfbee7feb'),
  ('2026-10-13', 'privacy', '12d920b6058a3873eb4cd301feacf1bcc4a4357808de11d5102b740afdebf74e'),
  ('2026-10-13', 'dpa', '57521f1ec38743511f38ba4dae2f936ae2d983ff2822deb35a2201f2f2bd6258')
on conflict (version, slug, text_hash) do nothing;

-- The body of 0016, with the text check added before the insert
create or replace function public.sign_agreement(
  p_version text, p_documents jsonb, p_full_name text, p_method text, p_signature text
) returns uuid
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_user    uuid := auth.uid();
  v_headers jsonb := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  v_id      uuid;
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_documents is null or jsonb_typeof(p_documents) <> 'array' or jsonb_array_length(p_documents) = 0 then
    raise exception 'nothing to sign' using errcode = '22023';
  end if;
  -- FXS-09: exactly the registered texts of this version, one document each, nothing else in them
  if not exists (select 1 from app.agreement_texts t where t.version = p_version)
     or jsonb_array_length(p_documents) <> (select count(distinct t.slug) from app.agreement_texts t where t.version = p_version)
     or exists (
       select 1 from jsonb_array_elements(p_documents) d
        where jsonb_typeof(d) <> 'object'
           or (select array_agg(k order by k) from jsonb_object_keys(d) k) is distinct from array['slug', 'text', 'title', 'version']
           or jsonb_typeof(d -> 'slug') <> 'string' or jsonb_typeof(d -> 'title') <> 'string'
           or jsonb_typeof(d -> 'text') <> 'string' or jsonb_typeof(d -> 'version') <> 'string'
           or (d ->> 'version') is distinct from p_version
           or not exists (select 1 from app.agreement_texts t
                           where t.version = p_version and t.slug = d ->> 'slug'
                             and t.text_hash = app.agreement_fingerprint(d ->> 'title', d ->> 'text')))
     or (select count(distinct d ->> 'slug') from jsonb_array_elements(p_documents) d) <> jsonb_array_length(p_documents) then
    raise exception 'these are not the texts of this agreement version' using errcode = 'P0001', hint = 'agreement:changed';
  end if;
  insert into app.agreement_signatures (user_id, version, documents, content_hash, full_name, method, signature, ip, user_agent)
  values (v_user, p_version, p_documents, encode(sha256(convert_to(p_documents::text, 'UTF8')), 'hex'), trim(p_full_name), p_method,
          case when p_method = 'drawn' then p_signature end,
          left(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), 64),
          left(v_headers ->> 'user-agent', 400))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.sign_agreement(text, jsonb, text, text, text) from public, anon;
grant execute on function public.sign_agreement(text, jsonb, text, text, text) to authenticated;

notify pgrst, 'reload schema';
