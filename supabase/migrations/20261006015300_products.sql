-- =============================================================================
-- The product catalog (PRD-01, PRD-02, wave 2)
-- =============================================================================
-- public.products: one row per product or service an organization sells
-- (SPEC-ADDITIONS 4.2). Business data: every member reads, owners and admins
-- of a writable organization write (PRD-06 will refine who edits; cost lives in
-- a separate table with its own permission, product_costs, not here).
--
-- Columns:
--   name, description      description is copied onto document lines and may
--                          be changed there (PRD-03, later waves)
--   sku                    optional, unique per organization ignoring case
--                          (products_sku_idx); stored trimmed
--   category_id            product_categories (PRD-04); set null when the
--                          category is removed
--   kind                   product | service | subscription | bundle. A bundle
--                          is only a kind for now; what it is made of is
--                          PRD-09 (wave 3)
--   unit_id                product_units (PRD-04); a unit in use cannot be
--                          removed (no cascade)
--   price_agorot, price_includes_vat, currency
--                          The sale price is stored exactly as it was typed,
--                          with the mode it was typed in (TAX-04): false =
--                          before VAT, true = including VAT. The form starts
--                          from the organization's prices_include_vat. Storing
--                          the typed number keeps "100.00 including VAT" exact;
--                          converting it to a net price would round and could
--                          come back as 100.01. A document line takes the
--                          price into its own mode with productPriceFor()
--                          (src/features/products/price.ts): the same number
--                          when the modes agree or the product carries no VAT,
--                          else x (10000 + rate) / 10000 or x 10000 / (10000 +
--                          rate), half up, at the document's rate; the
--                          document's totals then come from
--                          app.document_totals() (TAX-05) as for any line.
--                          Only a taxable product may say "including VAT"
--                          (products_price_vat_mode). Currency is ILS only
--                          (TAX-06).
--   vat_kind               taxable | exempt | zero_rate. Exempt and zero rate
--                          are calculated alike (no VAT) but kept apart
--                          (owner's default, 13 October 2026, TAX-05/06)
--   billing                one_time | monthly | quarterly | yearly
--   duration_minutes       a service's default length (calendar, bookings)
--   barcode                optional, not unique (searched)
--   is_active              an inactive product is not offered for new documents
--   archived_at            PRD-02: a product that appears in a document is
--                          archived, never removed. The server stamps the
--                          time (products_archive_stamp, migration
--                          product_archive). Archived products are hidden
--                          from the list by default.
--
-- RULE FOR THE DOCUMENT MODULES (quotes, orders, documents, deal lines; later
-- migrations): a product is offered for a NEW line only when
--   is_active and archived_at is null
-- (isOfferable() in src/features/products/schema.ts). Lines that exist keep
-- their copied values whatever happens to the product later.
--
-- REMOVAL (PRD-02): a person may remove a product only while nothing refers to
-- it. Every table of document lines that is added later MUST reference it with
--   foreign key (organization_id, product_id)
--     references public.products (organization_id, id)
-- and NO on delete action (the default, "no action"): then removing a product
-- that a line uses fails with 23503, and the app offers to archive it instead.
-- Never "on delete cascade" or "set null" from a document line.
-- tests/db/98-product-archive.test.ts proves this with a stand-in lines table.
--
-- No custom fields yet: field_definitions, app.check_custom_fields() and the
-- custom-field screens know five object types, and adding a sixth is shared
-- ground. No image yet (it needs a storage path and bucket of its own).
-- No plan quota yet: PRD-08 (max_products) adds a before insert trigger with
-- app.org_limit(organization_id, 'max_products') and the hint
-- 'limit:max_products', with the plan-flags branch.
--
-- Every statement is safe to run twice. No drops, no row removal.

create table if not exists public.products (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  name               text not null check (char_length(name) between 1 and 200 and name = btrim(name)),
  description        text check (description is null or char_length(description) between 1 and 4000),
  sku                text check (sku is null or (char_length(sku) between 1 and 64 and sku = btrim(sku))),
  category_id        uuid,
  kind               text not null default 'product' check (kind in ('product', 'service', 'subscription', 'bundle')),
  unit_id            uuid,
  price_agorot       bigint not null default 0 check (price_agorot between 0 and 1000000000000),
  price_includes_vat boolean not null default false,
  currency           text not null default 'ILS' check (currency = 'ILS'),
  vat_kind           text not null default 'taxable' check (vat_kind in ('taxable', 'exempt', 'zero_rate')),
  billing            text not null default 'one_time' check (billing in ('one_time', 'monthly', 'quarterly', 'yearly')),
  duration_minutes   integer check (duration_minutes is null or duration_minutes between 1 and 1440),
  barcode            text check (barcode is null or (char_length(barcode) between 1 and 64 and barcode = btrim(barcode))),
  is_active          boolean not null default true,
  archived_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (organization_id, id),
  constraint products_category_fk foreign key (organization_id, category_id)
    references public.product_categories (organization_id, id) on delete set null (category_id),
  -- no action: a unit in use cannot be removed
  constraint products_unit_fk foreign key (organization_id, unit_id)
    references public.product_units (organization_id, id),
  constraint products_price_vat_mode check (vat_kind = 'taxable' or not price_includes_vat)
);

create unique index if not exists products_sku_idx on public.products (organization_id, lower(sku)) where sku is not null;
create index if not exists products_name_idx on public.products (organization_id, lower(name));
create index if not exists products_category_idx on public.products (organization_id, category_id) where category_id is not null;
create index if not exists products_unit_idx on public.products (organization_id, unit_id) where unit_id is not null;
create index if not exists products_barcode_idx on public.products (organization_id, barcode) where barcode is not null;

alter table public.products enable row level security;

revoke all on public.products from anon, authenticated;
grant select, delete on public.products to authenticated;
grant insert (organization_id, name, description, sku, category_id, kind, unit_id, price_agorot, price_includes_vat, currency,
              vat_kind, billing, duration_minutes, barcode, is_active)
  on public.products to authenticated;
grant update (name, description, sku, category_id, kind, unit_id, price_agorot, price_includes_vat, currency,
              vat_kind, billing, duration_minutes, barcode, is_active, archived_at)
  on public.products to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'products' and policyname = 'products_select') then
    create policy products_select on public.products for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'products' and policyname = 'products_insert') then
    create policy products_insert on public.products for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'products' and policyname = 'products_update') then
    create policy products_update on public.products for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'products' and policyname = 'products_delete') then
    create policy products_delete on public.products for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger products_touch before update on public.products
  for each row execute function app.touch_row();
-- every change is audited, so price changes are in the audit log (PRD-07 shows them on the product)
create or replace trigger products_audit after insert or update or delete on public.products
  for each row execute function app.audit_row();

-- List sorting by category and unit name (like sort_owner, migration 0032):
-- computed fields PostgREST orders by (order=sort_category). Security invoker:
-- RLS decides.
create or replace function public.sort_category(public.products) returns text
language sql stable
set search_path = ''
as $$
  select c.name from public.product_categories c
   where c.organization_id = $1.organization_id and c.id = $1.category_id;
$$;
revoke all on function public.sort_category(public.products) from public, anon;
grant execute on function public.sort_category(public.products) to authenticated;

create or replace function public.sort_unit(public.products) returns text
language sql stable
set search_path = ''
as $$
  select u.name from public.product_units u
   where u.organization_id = $1.organization_id and u.id = $1.unit_id;
$$;
revoke all on function public.sort_unit(public.products) from public, anon;
grant execute on function public.sort_unit(public.products) to authenticated;
