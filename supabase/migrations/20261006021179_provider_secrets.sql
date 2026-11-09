-- =============================================================================
-- INT-02: a business's connections to providers, with their secrets stored encrypted
-- =============================================================================
-- "סודות החיבור נשמרים מוצפנים. סוד לא חוזר לדפדפן אחרי השמירה ולא נכתב לאף יומן" (SPEC-ADDITIONS, wave 3).
-- Owner, 26 October 2026 (DECISIONS.md, INT-02, answer (א)): the encryption key is an env var the owner sets in Vercel
-- (PROVIDER_SECRETS_KEY, Production and Preview); the database keeps ciphertext only; a key is replaced only with a process
-- that re-encrypts every stored secret.
--
-- * public.integrations: one connection of a business to a provider (closed list; today 'meta_lead_ads', CAP-11), with an
--   optional external id (a Meta page id), a display name, a status and non-secret settings. Owners and admins only, read
--   and write; audited by app.audit_row. It holds NO secret: secret_set_at / secret_key_version say only that one is stored
--   and under which key version (server-kept, no client grant).
-- * app.integration_secrets: the ciphertext, one per connection (schema app: no API role reads or writes it; RLS on, no
--   policies). The server encrypts (AES-256-GCM, src/features/integrations/crypto.ts; the additional data binds the
--   ciphertext to its business and connection, so a copied value does not decrypt elsewhere) and hands only the envelope
--   to public.integration_secret_set (definer, owners/admins of a writable business). The envelope's SHAPE is checked
--   (`ps1.<version>.<iv>.<data>.<tag>`), so a plain value is refused; the database never sees the key, so it cannot tell a
--   real envelope from well-shaped junk: a stored secret proves nothing about the provider (see "verified" below).
--   Nothing returns the ciphertext to a browser: only the service role reads it, through the definer function of the
--   use that needs it (CAP-11's public.meta_lead_claim).
-- * Key replacement (owner, 8 November 2026, answer (146) ג): no code now. The written procedure is in DECISIONS.md: the
--   new key goes into Vercel beside the old one (PROVIDER_SECRETS_KEY_PREVIOUS keeps the old one readable, so every
--   envelope carries its key version), a local script approved then as a new service-key use re-encrypts every stored
--   secret and checks the counts, and only then is the old key removed.
-- * Status: 'pending' (made, no secret yet) -> 'connected' (a secret was stored) -> 'disconnected' (a person switched it off)
--   or 'error' (the server saw the provider refuse the secret). A person sets only 'disconnected', or 'connected' again
--   while a secret is stored.
-- * Verified (review of 8 November 2026, finding 1, page squatting): `verified_at` (server only, no grant) is set only by
--   CAP-11's public.meta_lead_finish on a successful lead fetch with the connection's own token, the one proof that the
--   business holds the page. Only a VERIFIED live connection counts as taking a page: a page already verified elsewhere
--   refuses a connection going live or being verified (hint integration:taken); an unverified claim never blocks anyone.
--
-- No destructive statements and no escaped code points; every statement is safe to run twice.

create table if not exists public.integrations (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  provider           text not null check (provider in ('meta_lead_ads')),
  external_id        text check (external_id ~ '^[A-Za-z0-9._:-]{1,100}$'),
  name               text not null check (char_length(name) between 1 and 120 and name = btrim(name) and name !~ '[[:cntrl:]]'),
  status             text not null default 'pending' check (status in ('pending', 'connected', 'disconnected', 'error')),
  config             jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object' and octet_length(config::text) <= 2000),
  secret_set_at      timestamptz,
  secret_key_version integer check (secret_key_version between 1 and 9999),
  last_error_code    text check (last_error_code ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  last_error_at      timestamptz,
  verified_at        timestamptz,
  created_by         uuid default auth.uid() references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (organization_id, id),
  constraint integrations_secret_shape check ((secret_set_at is null) = (secret_key_version is null))
);
create unique index if not exists integrations_external_uniq
  on public.integrations (organization_id, provider, coalesce(external_id, ''));
create index if not exists integrations_org_idx on public.integrations (organization_id, created_at);
-- CAP-11: a webhook names a page; one VERIFIED live connection per page across businesses
create unique index if not exists integrations_meta_page_verified
  on public.integrations (provider, external_id)
  where provider = 'meta_lead_ads' and status in ('connected', 'error') and verified_at is not null;
create index if not exists integrations_meta_page_idx
  on public.integrations (provider, external_id) where provider = 'meta_lead_ads';

alter table public.integrations enable row level security;
revoke all on public.integrations from anon, authenticated;
grant select, delete on public.integrations to authenticated;
grant insert (organization_id, provider, external_id, name, config) on public.integrations to authenticated;
grant update (name, status, config) on public.integrations to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'integrations' and policyname = 'integrations_select') then
    create policy integrations_select on public.integrations for select to authenticated
      using (app.is_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'integrations' and policyname = 'integrations_insert') then
    create policy integrations_insert on public.integrations for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'integrations' and policyname = 'integrations_update') then
    create policy integrations_update on public.integrations for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'integrations' and policyname = 'integrations_delete') then
    create policy integrations_delete on public.integrations for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger integrations_touch before update on public.integrations
  for each row execute function app.touch_row();
create or replace trigger integrations_audit after insert or update or delete on public.integrations
  for each row execute function app.audit_row();

-- The envelope's key version, or null when the value is not an envelope of this format
create or replace function app.secret_envelope_version(p_value text) returns integer
language sql immutable
set search_path = ''
as $$
  -- PostgreSQL caps a bound at 255, so the length is its own check (12,000 for the data part, as crypto.ts writes)
  select case when char_length(p_value) <= 12100
               and p_value ~ '^ps1\.[0-9]{1,4}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'
              then split_part(p_value, '.', 2)::integer end
$$;
revoke all on function app.secret_envelope_version(text) from public, anon, authenticated, service_role;

-- The ciphertext, one per connection. Schema app: no grants, RLS on with no policies (RVW-15).
create table if not exists app.integration_secrets (
  integration_id  uuid primary key,
  organization_id uuid not null,
  ciphertext      text not null check (app.secret_envelope_version(ciphertext) is not null),
  key_version     integer not null check (key_version between 1 and 9999),
  updated_at      timestamptz not null default now(),
  constraint integration_secrets_integration_fk foreign key (organization_id, integration_id)
    references public.integrations (organization_id, id) on delete cascade
);
create index if not exists integration_secrets_org_idx on app.integration_secrets (organization_id, integration_id);
alter table app.integration_secrets enable row level security;
revoke all on app.integration_secrets from public, anon, authenticated, service_role;

-- Whether another business's (or another) VERIFIED live connection holds the page. Definer: it reads other businesses' rows
-- and answers only true or false (never whose). Locks the page id for the rest of the transaction, so two never both pass.
create or replace function app.integration_page_taken(p_page text, p_self uuid) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if p_page is null then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('meta_page:' || p_page, 0));
  return exists (select 1 from public.integrations i
                  where i.provider = 'meta_lead_ads' and i.external_id = p_page
                    and i.status in ('connected', 'error') and i.verified_at is not null
                    and i.id is distinct from p_self);
end;
$$;
revoke all on function app.integration_page_taken(text, uuid) from public, anon;
grant execute on function app.integration_page_taken(text, uuid) to authenticated, service_role;

-- A person's write: the status moves they may make (current_user tells a browser write, so INVOKER), and for every
-- writer one live connection per Meta page.
create or replace function app.integrations_check() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- a caller the write policy refuses gets RLS's plain 42501 (RVW-23)
  if auth.uid() is not null and not (app.is_admin(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  if current_user = 'authenticated' then
    if tg_op = 'INSERT' then
      -- a new connection waits for its secret
      new.status := 'pending';
      new.secret_set_at := null;
      new.secret_key_version := null;
      new.last_error_code := null;
      new.last_error_at := null;
      new.verified_at := null;
    elsif new.status is distinct from old.status then
      if not (new.status = 'disconnected'
              or (new.status = 'connected' and old.status in ('disconnected', 'error') and old.secret_set_at is not null)) then
        raise exception 'this connection cannot move to that status' using errcode = 'P0001', hint = 'integration:status';
      end if;
    end if;
  end if;
  if tg_op = 'UPDATE' and new.provider is distinct from old.provider then
    raise exception 'a connection keeps its provider' using errcode = 'P0001', hint = 'integration:fixed';
  end if;
  if new.provider = 'meta_lead_ads' and (new.external_id is null or new.external_id !~ '^[0-9]{1,40}$') then
    raise exception 'a Meta page id is digits' using errcode = 'P0001', hint = 'integration:page_id';
  end if;
  -- going live, or being verified, while another connection holds the page VERIFIED
  if new.provider = 'meta_lead_ads' and new.status in ('connected', 'error')
     and (tg_op = 'INSERT' or new.status is distinct from old.status or new.external_id is distinct from old.external_id
          or (new.verified_at is not null and old.verified_at is null))
     and app.integration_page_taken(new.external_id, new.id) then
    raise exception 'this page is connected elsewhere' using errcode = 'P0001', hint = 'integration:taken';
  end if;
  return new;
end;
$$;
revoke all on function app.integrations_check() from public, anon, authenticated;

create or replace trigger integrations_check before insert or update on public.integrations
  for each row execute function app.integrations_check();

-- The server stores a connection's encrypted secret (the user's session: owners/admins of a writable business).
-- Answers the connection's status. The value is an envelope only; the plain secret never reaches the database.
create or replace function public.integration_secret_set(p_org uuid, p_integration uuid, p_ciphertext text, p_key_version integer)
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_row public.integrations;
  v_page text;
begin
  if p_org is null or not app.is_admin(p_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not app.org_writable(p_org) then
    raise exception 'the organization is read-only' using errcode = 'P0001', hint = 'org:read_only';
  end if;
  if p_key_version is null or app.secret_envelope_version(p_ciphertext) is distinct from p_key_version then
    raise exception 'not an encrypted value' using errcode = '22023', hint = 'integration:secret_format';
  end if;
  -- review N2: the Meta page lock BEFORE the connection's row, the order public.meta_lead_finish takes them in (the
  -- going-live check in app.integrations_check takes the same lock again, re-entrant)
  select i.external_id into v_page from public.integrations i
   where i.organization_id = p_org and i.id = p_integration and i.provider = 'meta_lead_ads';
  if v_page is not null then
    perform pg_advisory_xact_lock(hashtextextended('meta_page:' || v_page, 0));
  end if;
  select * into v_row from public.integrations i
   where i.organization_id = p_org and i.id = p_integration
   for update;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  insert into app.integration_secrets (integration_id, organization_id, ciphertext, key_version)
  values (v_row.id, p_org, p_ciphertext, p_key_version)
  on conflict (integration_id) do update
    set ciphertext = excluded.ciphertext, key_version = excluded.key_version, updated_at = now();
  -- the connection's own row says only that a secret is stored (audited without it)
  update public.integrations i
     set status = 'connected', secret_set_at = now(), secret_key_version = p_key_version,
         last_error_code = null, last_error_at = null
   where i.organization_id = p_org and i.id = v_row.id;
  return 'connected';
end;
$$;
revoke all on function public.integration_secret_set(uuid, uuid, text, integer) from public, anon;
grant execute on function public.integration_secret_set(uuid, uuid, text, integer) to authenticated;
