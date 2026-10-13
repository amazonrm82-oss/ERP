-- =============================================================================
-- Product categories and units of measure as managed lists (PRD-04, wave 2)
-- =============================================================================
-- Two lists the product catalog (PRD-01, next migration) picks from. Both are
-- configuration, like deal_loss_reasons (0121): every member of the
-- organization reads them, owners and admins of a writable organization write.
--
-- public.product_categories: a tree of at most two levels. A top category has
-- parent_id null; a subcategory points at a top category of the same
-- organization (composite FK). Trigger product_categories_depth refuses a
-- parent that is itself a subcategory, a category as its own parent, and
-- giving a parent to a category that has subcategories (hint
-- 'product_categories:depth'). Removing a top category makes its
-- subcategories top categories (FK set null), nothing else goes with it.
-- Names are unique among siblings, ignoring case. At most 200 per
-- organization (hint 'product_categories:max').
--
-- public.product_units: the units a product is sold in. Names unique per
-- organization, ignoring case; at most 50 (hint 'product_units:max'). A unit
-- that products use cannot be removed (the products FK, next migration, has no
-- cascade); renaming it is always allowed. Documents of later waves copy the
-- unit's name onto their lines (SPEC 16.1), so a rename never changes them.
--
-- Defaults (managed-list rule, CLAUDE.md): app.seed_product_lists(org) fills a
-- list while it is empty; the trigger organizations_seed_product_lists seeds
-- every new organization (create_organization is not changed), and the
-- organizations that exist are seeded once at the end. The names mirror
-- DEFAULT_PRODUCT_UNITS and DEFAULT_PRODUCT_CATEGORIES in
-- src/features/products/lists.ts (tests/db/96-product-lists.test.ts keeps
-- them equal).
--
-- Clients write only the columns a person sets (column grants); organization_id
-- is fixed once inserted. Audited by app.audit_row(). Every statement is safe
-- to run twice. No drops, no row removal.

-- ----------------------------------------------------------------------------
-- Categories
-- ----------------------------------------------------------------------------
create table if not exists public.product_categories (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  parent_id       uuid,
  name            text not null check (char_length(name) between 1 and 80 and name = btrim(name)),
  position        integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  constraint product_categories_parent_fk foreign key (organization_id, parent_id)
    references public.product_categories (organization_id, id) on delete set null (parent_id),
  constraint product_categories_not_own_parent check (parent_id is distinct from id)
);

create unique index if not exists product_categories_name_idx
  on public.product_categories (organization_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
create index if not exists product_categories_org_idx on public.product_categories (organization_id, parent_id, position);

alter table public.product_categories enable row level security;

revoke all on public.product_categories from anon, authenticated;
grant select, delete on public.product_categories to authenticated;
grant insert (organization_id, parent_id, name, position) on public.product_categories to authenticated;
grant update (parent_id, name, position) on public.product_categories to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'product_categories' and policyname = 'product_categories_select') then
    create policy product_categories_select on public.product_categories for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'product_categories' and policyname = 'product_categories_insert') then
    create policy product_categories_insert on public.product_categories for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'product_categories' and policyname = 'product_categories_update') then
    create policy product_categories_update on public.product_categories for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'product_categories' and policyname = 'product_categories_delete') then
    create policy product_categories_delete on public.product_categories for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger product_categories_touch before update on public.product_categories
  for each row execute function app.touch_row();
create or replace trigger product_categories_audit after insert or update or delete on public.product_categories
  for each row execute function app.audit_row();

-- At most two levels, and at most 200 categories per organization.
create or replace function app.product_categories_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- one write at a time per organization, so two cannot pass the checks together
  -- (a count race, or A under B while B goes under A)
  perform pg_advisory_xact_lock(hashtextextended('product_categories:' || new.organization_id::text, 0));
  if tg_op = 'INSERT'
     and (select count(*) from public.product_categories c where c.organization_id = new.organization_id) >= 200 then
    raise exception 'too many product categories' using errcode = 'P0001', hint = 'product_categories:max';
  end if;
  if new.parent_id is not null and (tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id) then
    if new.parent_id = new.id then
      raise exception 'a category cannot be its own parent' using errcode = 'P0001', hint = 'product_categories:depth';
    end if;
    -- the parent must be a top category (a missing parent is the FK's error)
    if exists (select 1 from public.product_categories p
                where p.organization_id = new.organization_id and p.id = new.parent_id and p.parent_id is not null) then
      raise exception 'categories have at most two levels' using errcode = 'P0001', hint = 'product_categories:depth';
    end if;
    -- a category with subcategories stays a top category
    if tg_op = 'UPDATE' and exists (select 1 from public.product_categories c
                                     where c.organization_id = new.organization_id and c.parent_id = new.id) then
      raise exception 'categories have at most two levels' using errcode = 'P0001', hint = 'product_categories:depth';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.product_categories_check() from public, anon, authenticated;

create or replace trigger product_categories_check before insert or update of parent_id on public.product_categories
  for each row execute function app.product_categories_check();

-- ----------------------------------------------------------------------------
-- Units of measure
-- ----------------------------------------------------------------------------
create table if not exists public.product_units (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 30 and name = btrim(name)),
  position        integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id)
);

create unique index if not exists product_units_name_idx on public.product_units (organization_id, lower(name));
create index if not exists product_units_org_idx on public.product_units (organization_id, position);

alter table public.product_units enable row level security;

revoke all on public.product_units from anon, authenticated;
grant select, delete on public.product_units to authenticated;
grant insert (organization_id, name, position) on public.product_units to authenticated;
grant update (name, position) on public.product_units to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'product_units' and policyname = 'product_units_select') then
    create policy product_units_select on public.product_units for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'product_units' and policyname = 'product_units_insert') then
    create policy product_units_insert on public.product_units for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'product_units' and policyname = 'product_units_update') then
    create policy product_units_update on public.product_units for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'product_units' and policyname = 'product_units_delete') then
    create policy product_units_delete on public.product_units for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger product_units_touch before update on public.product_units
  for each row execute function app.touch_row();
create or replace trigger product_units_audit after insert or update or delete on public.product_units
  for each row execute function app.audit_row();

create or replace function app.product_units_cap() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('product_units:' || new.organization_id::text, 0));
  if (select count(*) from public.product_units u where u.organization_id = new.organization_id) >= 50 then
    raise exception 'too many units' using errcode = 'P0001', hint = 'product_units:max';
  end if;
  return new;
end;
$$;
revoke all on function app.product_units_cap() from public, anon, authenticated;

create or replace trigger product_units_cap before insert on public.product_units
  for each row execute function app.product_units_cap();

-- ----------------------------------------------------------------------------
-- Defaults for every organization
-- ----------------------------------------------------------------------------
create or replace function app.seed_product_lists(p_org uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_units constant text[] := array['יחידה', 'שעה', 'יום', 'חודש', 'מ"ר', 'ק"ג', 'ליטר', 'מטר'];
  v_categories constant text[] := array['כללי'];
begin
  insert into public.product_units (organization_id, name, position)
  select p_org, d.name, (d.n - 1)::integer
    from unnest(v_units) with ordinality as d(name, n)
   where not exists (select 1 from public.product_units u where u.organization_id = p_org)
   order by d.n;
  insert into public.product_categories (organization_id, name, position)
  select p_org, d.name, (d.n - 1)::integer
    from unnest(v_categories) with ordinality as d(name, n)
   where not exists (select 1 from public.product_categories c where c.organization_id = p_org)
   order by d.n;
end;
$$;
revoke all on function app.seed_product_lists(uuid) from public, anon, authenticated;

create or replace function app.organizations_seed_product_lists() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform app.seed_product_lists(new.id);
  return null;
end;
$$;
revoke all on function app.organizations_seed_product_lists() from public, anon, authenticated;

create or replace trigger organizations_seed_product_lists after insert on public.organizations
  for each row execute function app.organizations_seed_product_lists();

-- the organizations that exist today (a list that already has rows is left alone)
select app.seed_product_lists(o.id) from public.organizations o;
