-- QUO-04: content templates. A quote saved as a template (its lines, notes and terms) for a quick
-- start of the next one.
--
-- public.quote_templates       name (unique per business, case and spaces folded), notes, terms, and
--                              the VAT mode its typed prices were written in (prices_include_vat).
-- public.quote_template_lines  the lines, in order: items (catalog or free) and group headings, with
--                              quantity, discount, optional / preselected. A product line's price is
--                              either typed (kept as typed) or null = the automatic price when used
--                              (the customer's price list, else the product's price: PL-03, worked
--                              out by the app for the quote it is used in). A free line has a price.
--
-- Rights (like the other managed content of a business, e.g. WhatsApp templates):
-- * read: every member;
-- * write: owners and admins of a writable business (app.is_admin, app.org_writable);
-- * a new template needs the plan flag 'quotes' and counts against max_quote_templates
--   (definer trigger quote_templates_quota with the outsider guard first: a person who may not
--   write templates is left to RLS, 42501, and learns nothing about the plan);
-- * at most 200 lines per template (hint quote_template_lines:max), like a quote.
-- Products on template lines: composite FK with no on delete action (PRD-02), so a used product
-- can only be archived. Using a template skips a line whose product is no longer offerable.
--
-- public.quote_template_save(org, quote, name) (security invoker): one transaction that makes a
-- template from a quote the caller reads; RLS decides both the read and the writes.
--
-- Also (QUO-01/02 follow-up): none. The one-way status question waits for QUO-12 (see the report).
--
-- Every statement is safe to run twice. No drops, no row removal.

-- ----------------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------------
create table if not exists public.quote_templates (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  name                text not null check (char_length(btrim(name)) between 1 and 120),
  notes               text check (notes is null or char_length(notes) <= 4000),
  terms               text check (terms is null or char_length(terms) <= 8000),
  prices_include_vat  boolean not null default false,
  currency            text not null default 'ILS' check (currency = 'ILS'),
  created_by          uuid references auth.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (organization_id, id)
);

create unique index if not exists quote_templates_name_key
  on public.quote_templates (organization_id, lower(btrim(name)));

create table if not exists public.quote_template_lines (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  template_id        uuid not null,
  position           integer not null default 0 check (position between 0 and 100000),
  kind               text not null default 'item' check (kind in ('item', 'group')),
  product_id         uuid,
  name               text not null check (char_length(btrim(name)) between 1 and 300),
  description        text check (description is null or char_length(description) <= 2000),
  quantity           numeric not null default 1,
  unit_price_agorot  bigint check (unit_price_agorot is null or unit_price_agorot between 0 and 1000000000000),
  discount_bp        integer check (discount_bp is null or discount_bp between 1 and 10000),
  discount_agorot    bigint check (discount_agorot is null or discount_agorot between 1 and 1000000000000),
  vat_exempt         boolean not null default false,
  billing            text not null default 'one_time' check (billing in ('one_time', 'monthly', 'quarterly', 'yearly')),
  is_optional        boolean not null default false,
  optional_selected  boolean not null default false,
  currency           text not null default 'ILS' check (currency = 'ILS'),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (organization_id, id),
  constraint quote_template_lines_template_fk foreign key (organization_id, template_id)
    references public.quote_templates (organization_id, id) on delete cascade,
  -- no action: a product on a template line cannot be removed, only archived (PRD-02)
  constraint quote_template_lines_product_fk foreign key (organization_id, product_id)
    references public.products (organization_id, id),
  constraint quote_template_lines_quantity check (quantity > 0 and quantity <= 1000000 and quantity = round(quantity, 3)),
  constraint quote_template_lines_one_discount check (discount_bp is null or discount_agorot is null),
  constraint quote_template_lines_optional check (is_optional or not optional_selected),
  -- a free item has its own price; a product item may leave it to the catalog
  constraint quote_template_lines_free_price check (kind = 'group' or product_id is not null or unit_price_agorot is not null),
  constraint quote_template_lines_group_shape check (
    kind = 'item'
    or (product_id is null and discount_bp is null and discount_agorot is null and not is_optional
        and unit_price_agorot is null and quantity = 1))
);

create index if not exists quote_template_lines_template_idx
  on public.quote_template_lines (organization_id, template_id, position);
create index if not exists quote_template_lines_product_idx
  on public.quote_template_lines (organization_id, product_id) where product_id is not null;

alter table public.quote_templates enable row level security;
alter table public.quote_template_lines enable row level security;

revoke all on public.quote_templates from anon, authenticated;
grant select, delete on public.quote_templates to authenticated;
grant insert (organization_id, name, notes, terms, prices_include_vat, currency) on public.quote_templates to authenticated;
grant update (name, notes, terms) on public.quote_templates to authenticated;

revoke all on public.quote_template_lines from anon, authenticated;
grant select, delete on public.quote_template_lines to authenticated;
grant insert (organization_id, template_id, position, kind, product_id, name, description, quantity, unit_price_agorot,
              discount_bp, discount_agorot, vat_exempt, billing, is_optional, optional_selected, currency)
  on public.quote_template_lines to authenticated;
grant update (position, name, description, quantity, unit_price_agorot, discount_bp, discount_agorot, vat_exempt, billing,
              is_optional, optional_selected)
  on public.quote_template_lines to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_templates' and policyname = 'quote_templates_select') then
    create policy quote_templates_select on public.quote_templates for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_templates' and policyname = 'quote_templates_insert') then
    create policy quote_templates_insert on public.quote_templates for insert to authenticated
      -- the plan flag and the allowance: trigger quote_templates_quota (every writer)
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_templates' and policyname = 'quote_templates_update') then
    create policy quote_templates_update on public.quote_templates for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_templates' and policyname = 'quote_templates_delete') then
    create policy quote_templates_delete on public.quote_templates for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_template_lines' and policyname = 'quote_template_lines_select') then
    create policy quote_template_lines_select on public.quote_template_lines for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_template_lines' and policyname = 'quote_template_lines_insert') then
    create policy quote_template_lines_insert on public.quote_template_lines for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_template_lines' and policyname = 'quote_template_lines_update') then
    create policy quote_template_lines_update on public.quote_template_lines for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_template_lines' and policyname = 'quote_template_lines_delete') then
    create policy quote_template_lines_delete on public.quote_template_lines for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- Plan flag and allowance of a new template
-- ----------------------------------------------------------------------------
create or replace function app.quote_templates_quota() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_limit numeric;
begin
  -- A person who may not write templates is refused by RLS (42501) right after this trigger;
  -- answering here would tell them the business's plan state. auth.uid(), not current_user:
  -- inside a definer current_user is the owner. Server writers without a session are checked.
  if auth.uid() is not null and not (app.is_admin(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  if not app.org_has_feature(new.organization_id, 'quotes') then
    raise exception 'quotes are not in this plan' using errcode = 'P0001', hint = 'feature:quotes';
  end if;
  v_limit := app.org_limit(new.organization_id, 'max_quote_templates');
  if v_limit is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('quote_templates:' || new.organization_id::text, 0));
  if (select count(*) from public.quote_templates t where t.organization_id = new.organization_id) + 1 > v_limit then
    raise exception 'plan limit reached (max_quote_templates = %)', v_limit using errcode = 'P0001', hint = 'limit:max_quote_templates';
  end if;
  return new;
end;
$$;
revoke all on function app.quote_templates_quota() from public, anon, authenticated;

create or replace trigger quote_templates_quota before insert on public.quote_templates
  for each row execute function app.quote_templates_quota();
create or replace trigger quote_templates_touch before insert or update on public.quote_templates
  for each row execute function app.touch_row();
create or replace trigger quote_templates_audit after insert or update or delete on public.quote_templates
  for each row execute function app.audit_row();

-- ----------------------------------------------------------------------------
-- The lines: cap, and the template and product stay fixed
-- ----------------------------------------------------------------------------
create or replace function app.quote_template_lines_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- outsider guard: RLS refuses (42501) a person who may not write templates
  if auth.uid() is not null and not (app.is_admin(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('quote_template_lines:' || new.template_id::text, 0));
    if (select count(*) from public.quote_template_lines l
         where l.organization_id = new.organization_id and l.template_id = new.template_id) >= 200 then
      raise exception 'at most 200 lines in a template' using errcode = 'P0001', hint = 'quote_template_lines:max';
    end if;
  else
    new.organization_id := old.organization_id;
    new.template_id := old.template_id;
    new.kind := old.kind;
    new.product_id := old.product_id;
  end if;
  return new;
end;
$$;
revoke all on function app.quote_template_lines_check() from public, anon, authenticated;

create or replace trigger quote_template_lines_check before insert or update on public.quote_template_lines
  for each row execute function app.quote_template_lines_check();
create or replace trigger quote_template_lines_touch before insert or update on public.quote_template_lines
  for each row execute function app.touch_row();
create or replace trigger quote_template_lines_audit after insert or update or delete on public.quote_template_lines
  for each row execute function app.audit_row();

-- ----------------------------------------------------------------------------
-- A quote saved as a template, in one transaction. Security invoker: the quote and its lines are
-- read under the caller's RLS, and the template is written under it (owners and admins). A
-- product line priced automatically (from the product or a price list) is saved without a price,
-- so it is priced again for the next customer; a price someone typed is kept.
-- ----------------------------------------------------------------------------
create or replace function public.quote_template_save(p_org uuid, p_quote uuid, p_name text) returns uuid
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_quote record;
  v_id uuid;
begin
  select q.id, q.notes, q.terms, q.prices_include_vat into v_quote
    from public.quotes q where q.organization_id = p_org and q.id = p_quote;
  if not found then
    raise exception 'quote not found' using errcode = 'P0001', hint = 'quote_templates:quote';
  end if;
  insert into public.quote_templates (organization_id, name, notes, terms, prices_include_vat)
  values (p_org, btrim(p_name), v_quote.notes, v_quote.terms, v_quote.prices_include_vat)
  returning id into v_id;
  insert into public.quote_template_lines (organization_id, template_id, position, kind, product_id, name, description,
                                           quantity, unit_price_agorot, discount_bp, discount_agorot, vat_exempt, billing,
                                           is_optional, optional_selected)
  select p_org, v_id, row_number() over (order by l.position, l.created_at, l.id), l.kind, l.product_id, l.name,
         l.description, l.quantity,
         case when l.kind = 'group' then null
              when l.product_id is not null and l.price_source <> 'manual' then null
              else l.unit_price_agorot end,
         l.discount_bp, l.discount_agorot, l.vat_exempt, l.billing, l.is_optional, l.optional_selected
    from public.quote_lines l
   where l.organization_id = p_org and l.quote_id = p_quote;
  return v_id;
end;
$$;
revoke all on function public.quote_template_save(uuid, uuid, text) from public, anon;
grant execute on function public.quote_template_save(uuid, uuid, text) to authenticated;
