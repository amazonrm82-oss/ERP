-- =============================================================================
-- The business's VAT status, apart from its legal form (TAX-01, wave 2)
-- =============================================================================
-- public.org_document_settings: at most one row per organization, the tax and
-- document settings of the business. This migration adds the tax part; TAX-02
-- adds the business details printed on documents.
--   legal_form         צורת ההתאגדות: individual | company | partnership |
--                      nonprofit | other; null = not said. Informational only:
--                      it never decides whether VAT is charged.
--   vat_status         מעמד במע"מ (null = not set yet): licensed (עוסק מורשה, charges VAT) |
--                      exempt (עוסק פטור) | nonprofit (מלכ"ר / מוסד ללא כוונת
--                      רווח) | other (a status set with the accountant).
--   vat_status_other   the name of an 'other' status (1..80 characters); null
--                      for every other status.
--   other_charges_vat  whether an 'other' status charges VAT; required for
--                      'other', null for every other status.
-- vat_status null (or no row) means the business has not said yet:
-- app.org_charges_vat() answers null and the document code (quotes, documents; later waves) must ask for
-- the setting before it prints a total, instead of guessing.
-- The rule "whoever does not charge VAT shows no VAT on any document" lives in
-- one place on each side and every document must use it:
--   SQL  app.vat_status_charges(status, other_charges_vat), app.org_charges_vat(org)
--   TS   chargesVat() in src/features/tax/status.ts (unit test keeps them equal)
-- * Everyone in the organization reads it (quotes are made by members).
-- * Owners and admins write it while the organization is writable, like the
--   other configuration tables. Audited.
-- * Read-only / suspended organization: reading goes on, nothing changes. No
--   plan limit or feature flag. Handover, merge: not involved. Full export:
--   configuration, like the rest days.
-- Every statement is safe to run twice.

create table if not exists public.org_document_settings (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  legal_form        text
                    constraint org_document_settings_legal_form_check
                    check (legal_form in ('individual', 'company', 'partnership', 'nonprofit', 'other')),
  vat_status        text
                    constraint org_document_settings_vat_status_check
                    check (vat_status in ('licensed', 'exempt', 'nonprofit', 'other')),
  vat_status_other  text,
  other_charges_vat boolean,
  updated_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id),
  constraint org_document_settings_other_check check (
    case when vat_status = 'other'
      then vat_status_other is not null and char_length(btrim(vat_status_other)) between 1 and 80
           and other_charges_vat is not null
      else vat_status_other is null and other_charges_vat is null
    end)
);

comment on table public.org_document_settings is
  'TAX-01/TAX-02: the tax status and document details of the business, at most one row per organization.';
comment on column public.org_document_settings.vat_status is
  'TAX-01: licensed | exempt | nonprofit | other; null = not set yet. Whether VAT is charged: app.vat_status_charges(); never decided from legal_form.';

create or replace trigger org_document_settings_touch before insert or update on public.org_document_settings
  for each row execute function app.touch_row();
create or replace trigger org_document_settings_audit after insert or update or delete on public.org_document_settings
  for each row execute function app.audit_row();

alter table public.org_document_settings enable row level security;
revoke all on public.org_document_settings from anon, authenticated;
grant select, delete on public.org_document_settings to authenticated;
grant insert (organization_id, legal_form, vat_status, vat_status_other, other_charges_vat)
  on public.org_document_settings to authenticated;
grant update (legal_form, vat_status, vat_status_other, other_charges_vat)
  on public.org_document_settings to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_document_settings' and policyname = 'org_document_settings_select') then
    create policy org_document_settings_select on public.org_document_settings for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_document_settings' and policyname = 'org_document_settings_insert') then
    create policy org_document_settings_insert on public.org_document_settings for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_document_settings' and policyname = 'org_document_settings_update') then
    create policy org_document_settings_update on public.org_document_settings for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_document_settings' and policyname = 'org_document_settings_delete') then
    create policy org_document_settings_delete on public.org_document_settings for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- The one rule: does this status charge VAT? Mirrors chargesVat() in
-- src/features/tax/status.ts. Unknown status -> null (never "yes" by default).
-- ----------------------------------------------------------------------------
create or replace function app.vat_status_charges(p_status text, p_other_charges_vat boolean) returns boolean
language sql immutable
set search_path = ''
as $$
  select case p_status
    when 'licensed' then true
    when 'exempt' then false
    when 'nonprofit' then false
    when 'other' then p_other_charges_vat
  end
$$;
revoke all on function app.vat_status_charges(text, boolean) from public, anon;
grant execute on function app.vat_status_charges(text, boolean) to authenticated, service_role;

-- Whether the organization charges VAT on its documents; null = not set yet.
-- Security invoker: the caller's RLS decides (a non-member gets null); a
-- security definer document function that calls it reads the row as owner.
create or replace function app.org_charges_vat(p_org uuid) returns boolean
language sql stable security invoker
set search_path = ''
as $$
  select app.vat_status_charges(s.vat_status, s.other_charges_vat)
    from public.org_document_settings s
   where s.organization_id = p_org
$$;
revoke all on function app.org_charges_vat(uuid) from public, anon;
grant execute on function app.org_charges_vat(uuid) to authenticated, service_role;
