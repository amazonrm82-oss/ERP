-- =============================================================================
-- DOC-05 (first part): a business's connection to its invoice provider, and its defaults; DOC-17: who issues
-- =============================================================================
-- Owner (270) (1) א, 11 November 2026: built behind a fake provider and hidden on the live site until a real adapter exists.
-- The provider a deployment offers is the server's env (INVOICE_PROVIDER, src/features/invoicing/providers/select.ts, the
-- fake refused on production and preview); the database keeps only what a business chose:
--
-- * public.invoice_provider_settings: one row per business. `provider` (a code, the shape of accounting_documents.provider),
--   `status` connected | disconnected, `connected_at` / `connected_by`, and the last connection check (`last_check_at`,
--   `last_check_ok`) are the server's: no client grant; written only by the functions below. The defaults a person sets
--   (owners and admins of a writable business, column grants): the document type a new issue starts with (tax invoice,
--   tax invoice-receipt, receipt, proforma), the document language (he | en) and whether the provider emails the document
--   to the customer. Members read the row (an issuer needs to know whether the business is connected). No delete; audited.
--   No secret is kept here: a real provider's key will be stored encrypted (INT-02, app.integration_secrets) when its adapter
--   is built, and reading it back for a call is a new service-key use that waits for the owner (hard rule 5).
-- * public.invoice_provider_connect(org, provider): owners and admins of a writable business with the `documents` key; the
--   server calls it only after the provider's own connection check passed (DOC-05 "בדיקת חיבור"). Makes the row or sets it
--   connected. public.invoice_provider_disconnect(org): the same people, without the key (switching off is the safe side).
--   public.invoice_provider_check_recorded(org, ok): the result of a later "test the connection" press, for the fake only
--   (a person cannot record a check result for a real provider; that will be the server's, with the adapter).
-- * The providers are a CLOSED list, app.invoice_provider_usable(code): today only 'fake', and 'fake' only while the
--   app.settings key `invoice_provider_fake` is 'on'. No migration sets that key: tests and local stacks set it by hand; on the
--   hosted project it is unset, so connecting, beginning, and the worker's claim and record through the fake are refused there (hint
--   invoice:provider). A real provider joins the list with its adapter, in its own migration.
-- * DOC-17: app.can_issue_documents(org) = owners and admins by role, or the PRM-01 key `issue_documents`, which is now
--   built (app.member_permission_built_keys, 020635's list plus the key). Managers record documents (DOC-01) but do not
--   issue them unless granted the key. Crediting (`issue_credits`, DOC-14) is not built yet.
-- Every statement is safe to run twice. No drops, no row removal, no escaped code points.

create table if not exists public.invoice_provider_settings (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete cascade,
  provider              text check (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  status                text not null default 'disconnected' check (status in ('connected', 'disconnected')),
  connected_at          timestamptz,
  connected_by          uuid references auth.users (id) on delete set null,
  last_check_at         timestamptz,
  last_check_ok         boolean,
  default_doc_type      text not null default 'tax_invoice'
                          check (default_doc_type in ('tax_invoice', 'tax_invoice_receipt', 'receipt', 'proforma')),
  locale                text not null default 'he' check (locale in ('he', 'en')),
  provider_sends_email  boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id),
  constraint invoice_provider_settings_connected check (status <> 'connected' or (provider is not null and connected_at is not null)),
  constraint invoice_provider_settings_check_shape check ((last_check_at is null) = (last_check_ok is null))
);
comment on table public.invoice_provider_settings is
  'DOC-05: the business''s invoice provider (server-kept) and its issue defaults. No row = not connected.';

create or replace trigger invoice_provider_settings_touch before insert or update on public.invoice_provider_settings
  for each row execute function app.touch_row();
create or replace trigger invoice_provider_settings_audit after insert or update or delete on public.invoice_provider_settings
  for each row execute function app.audit_row();

alter table public.invoice_provider_settings enable row level security;
revoke all on public.invoice_provider_settings from anon, authenticated;
grant select on public.invoice_provider_settings to authenticated;
grant insert (organization_id, default_doc_type, locale, provider_sends_email) on public.invoice_provider_settings to authenticated;
grant update (default_doc_type, locale, provider_sends_email) on public.invoice_provider_settings to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invoice_provider_settings'
                   and policyname = 'invoice_provider_settings_select') then
    create policy invoice_provider_settings_select on public.invoice_provider_settings for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invoice_provider_settings'
                   and policyname = 'invoice_provider_settings_insert') then
    create policy invoice_provider_settings_insert on public.invoice_provider_settings for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invoice_provider_settings'
                   and policyname = 'invoice_provider_settings_update') then
    create policy invoice_provider_settings_update on public.invoice_provider_settings for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- DOC-17: who issues
-- ----------------------------------------------------------------------------
create or replace function app.can_issue_documents(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(app.role_in(p_org)::text in ('owner', 'admin'), false) or app.has_grant(p_org, 'issue_documents');
$$;
revoke all on function app.can_issue_documents(uuid) from public, anon;
grant execute on function app.can_issue_documents(uuid) to authenticated, service_role;

-- 020635's list, plus `issue_documents` (DOC-17)
create or replace function app.member_permission_built_keys() returns text[]
language sql immutable
set search_path = ''
as $$
  select array['export', 'import', 'edit_catalog', 'manage_automations', 'view_costs', 'documents', 'record_payments', 'issue_documents']::text[]
$$;
revoke all on function app.member_permission_built_keys() from public, anon;
grant execute on function app.member_permission_built_keys() to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The closed list of providers (no grants: definers ask it)
-- ----------------------------------------------------------------------------
create or replace function app.invoice_provider_usable(p_provider text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(p_provider = any (array['fake']::text[]), false)
     and (p_provider <> 'fake'
          or coalesce((select s.value from app.settings s where s.key = 'invoice_provider_fake'), '') = 'on');
$$;
revoke all on function app.invoice_provider_usable(text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The server's half of the row
-- ----------------------------------------------------------------------------
-- The person's connect: owners and admins of a writable business with the `documents` key, after the server ran the
-- provider's own connection check (src/features/invoicing/actions.ts). It takes the fake only: a real provider's connection
-- carries its key (INT-02) and its check result, which only a server-only path may write (it comes with the adapter and
-- needs the owner's approval); until then a real provider is refused here (hint invoice:provider).
create or replace function public.invoice_provider_connect(p_org uuid, p_provider text) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if not (app.is_admin(p_org) and app.org_writable(p_org)) then
    raise exception 'only owners and admins connect an invoice provider' using errcode = '42501';
  end if;
  if not app.org_has_feature(p_org, 'documents') then
    raise exception 'the plan has no documents' using errcode = 'P0001', hint = 'feature:documents';
  end if;
  if p_provider is null or p_provider !~ '^[a-z][a-z0-9_]{1,39}$' then
    raise exception 'unknown provider' using errcode = '22023';
  end if;
  if p_provider <> 'fake' or not app.invoice_provider_usable(p_provider) then
    raise exception 'this provider is not offered' using errcode = 'P0001', hint = 'invoice:provider';
  end if;
  insert into public.invoice_provider_settings
    (organization_id, provider, status, connected_at, connected_by, last_check_at, last_check_ok)
  values (p_org, p_provider, 'connected', now(), auth.uid(), now(), true)
  on conflict (organization_id) do update
    set provider = excluded.provider, status = 'connected', connected_at = now(), connected_by = auth.uid(),
        last_check_at = now(), last_check_ok = true;
end;
$$;
revoke all on function public.invoice_provider_connect(uuid, text) from public, anon;
grant execute on function public.invoice_provider_connect(uuid, text) to authenticated;

create or replace function public.invoice_provider_disconnect(p_org uuid) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if not (app.is_admin(p_org) and app.org_writable(p_org)) then
    raise exception 'only owners and admins disconnect an invoice provider' using errcode = '42501';
  end if;
  update public.invoice_provider_settings s set status = 'disconnected'
   where s.organization_id = p_org and s.status = 'connected';
end;
$$;
revoke all on function public.invoice_provider_disconnect(uuid) from public, anon;
grant execute on function public.invoice_provider_disconnect(uuid) to authenticated;

create or replace function public.invoice_provider_check_recorded(p_org uuid, p_ok boolean) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if not (app.is_admin(p_org) and app.org_writable(p_org)) then
    raise exception 'only owners and admins test the connection' using errcode = '42501';
  end if;
  if p_ok is null then
    raise exception 'a check passes or fails' using errcode = '22023';
  end if;
  -- a person's word records a check of the fake only; a real provider's check is the server's (with its adapter)
  if exists (select 1 from public.invoice_provider_settings s
              where s.organization_id = p_org and s.status = 'connected'
                and (s.provider <> 'fake' or not app.invoice_provider_usable(s.provider))) then
    raise exception 'this provider''s check is not recorded here' using errcode = 'P0001', hint = 'invoice:provider';
  end if;
  update public.invoice_provider_settings s set last_check_at = now(), last_check_ok = p_ok
   where s.organization_id = p_org and s.status = 'connected';
end;
$$;
revoke all on function public.invoice_provider_check_recorded(uuid, boolean) from public, anon;
grant execute on function public.invoice_provider_check_recorded(uuid, boolean) to authenticated;
