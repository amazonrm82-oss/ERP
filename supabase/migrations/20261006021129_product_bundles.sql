-- =============================================================================
-- Bundles (PRD-09, wave 3)
-- =============================================================================
-- SPEC-ADDITIONS 4.2: "a bundle: a product made of other products with
-- quantities. On a document it shows as one line or itemised."
--
-- A bundle is a product whose kind is 'bundle' (the kind exists since
-- migration products). What it is made of lives in a new table:
--
-- public.product_bundle_items: one row per (bundle, component product).
--   bundle_id        the bundle (a product of kind 'bundle'); composite FK,
--                    ON DELETE CASCADE: the parts belong to the bundle.
--   component_id     the part; composite FK with NO on delete action (PRD-02):
--                    a product that is part of a bundle can only be archived.
--                    Never a bundle itself (no nesting), never the bundle.
--   quantity         per one bundle, > 0, up to three decimals (like a line).
--   position         the order on the product page.
-- At most 50 parts per bundle (hint 'product_bundle:max'). A person adds only an
-- offerable part (active, not archived; hint 'product_bundle:component'); a part
-- that is archived later stays in the bundle. Rights are the catalog's: members
-- read, app.can_edit_catalog of a writable business writes, and adding needs the
-- plan's capability 'products' (a bundle is part of the catalog; no key of its
-- own). Audited; in the full export.
--
-- The bundle's price is its own product price, as typed. The sum of its parts
-- is shown on the product page for reference only.
--
-- products: a bundle that has parts cannot stop being a bundle
-- ('product_bundle:has_items'), and a product that is a part of a bundle cannot
-- become one ('product_bundle:nested'), for every writer (products_bundle_kind).
--
-- Document lines (deal_lines, quote_lines, order_lines) get
--   bundle_display   'single' | 'itemised', set only on a line whose product is a
--                    bundle (null on any other line; 'single' when not sent).
--                    A person chooses it on a deal line, a draft quote's line or a
--                    draft order's line; once the quote left draft or the order got
--                    its number it is frozen for every writer (quote:frozen,
--                    order:frozen).
-- and quote_lines / order_lines also
--   bundle_items     the parts when the line was added: [{name, quantity,
--                    unit_name}] per one bundle (server only; never changed
--                    after the insert, for every writer). A later change of the
--                    bundle never changes a quote or an order. The app shows
--                    quantity x the line's quantity, no prices of their own.
-- A deal line keeps only the choice: the deal page reads the parts live (a deal is
-- not a document).
-- The totals rule is unchanged: a bundle line is priced like any line, at the
-- bundle's own price (PL-03 included). Reports by product count the bundle as
-- itself and never split it into its parts.
-- Copies keep the choice: a quote's new version (QUO-12, app.quote_version_copy)
-- takes the previous version's choice and parts for the same place and product;
-- a duplicate (QUO-15, redefined from 020550 only for this) keeps the choice and
-- takes the parts again from the catalog; an order made from a quote takes the
-- quote line's choice and parts (same place and product), one made from a won
-- deal the deal line's choice. Paths that make lines without a choice (an
-- automation's quote from a template, an accepted quote's lines on its deal,
-- quick sale) get 'single'.
-- quote_public and order_public add 'components' to an itemised line (bodies of
-- 021128 and 021119, nothing else changed). The staff documents and PDFs read
-- the lines with the user's session.
-- Not touched: accounting_document_lines (DOC-02) take free lines only; a
-- bundle there is one line by its text.
--
-- Lead's decisions (2 November 2026, no owner question): a duplicate takes the
-- parts fresh from the catalog; quote templates do not store the display
-- choice; deal lines written from an accepted quote (QUO-13) start as 'single'.
--
-- Every statement is safe to run twice. No drops, no row removal.

-- -----------------------------------------------------------------------------
-- The parts of a bundle
-- -----------------------------------------------------------------------------
create table if not exists public.product_bundle_items (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  bundle_id          uuid not null,
  component_id       uuid not null,
  quantity           numeric not null default 1,
  position           integer not null default 0 check (position between 0 and 100000),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (organization_id, id),
  constraint product_bundle_items_bundle_fk foreign key (organization_id, bundle_id)
    references public.products (organization_id, id) on delete cascade,
  -- no action: a part of a bundle cannot be removed, only archived
  constraint product_bundle_items_component_fk foreign key (organization_id, component_id)
    references public.products (organization_id, id),
  constraint product_bundle_items_not_self check (bundle_id <> component_id),
  constraint product_bundle_items_quantity check (quantity > 0 and quantity <= 1000000 and quantity = round(quantity, 3)),
  constraint product_bundle_items_once unique (organization_id, bundle_id, component_id)
);

create index if not exists product_bundle_items_bundle_idx on public.product_bundle_items (organization_id, bundle_id);
-- removing a product looks up the bundles it is part of
create index if not exists product_bundle_items_component_idx on public.product_bundle_items (organization_id, component_id);

alter table public.product_bundle_items enable row level security;

revoke all on public.product_bundle_items from anon, authenticated;
grant select, delete on public.product_bundle_items to authenticated;
grant insert (organization_id, bundle_id, component_id, quantity, position) on public.product_bundle_items to authenticated;
grant update (quantity, position) on public.product_bundle_items to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'product_bundle_items' and policyname = 'product_bundle_items_select') then
    create policy product_bundle_items_select on public.product_bundle_items for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'product_bundle_items' and policyname = 'product_bundle_items_insert') then
    create policy product_bundle_items_insert on public.product_bundle_items for insert to authenticated
      with check (app.can_edit_catalog(organization_id) and app.org_writable(organization_id)
                  and app.org_has_feature(organization_id, 'products'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'product_bundle_items' and policyname = 'product_bundle_items_update') then
    create policy product_bundle_items_update on public.product_bundle_items for update to authenticated
      using (app.can_edit_catalog(organization_id) and app.org_writable(organization_id))
      with check (app.can_edit_catalog(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'product_bundle_items' and policyname = 'product_bundle_items_delete') then
    create policy product_bundle_items_delete on public.product_bundle_items for delete to authenticated
      using (app.can_edit_catalog(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger product_bundle_items_touch before update on public.product_bundle_items
  for each row execute function app.touch_row();
create or replace trigger product_bundle_items_audit after insert or update or delete on public.product_bundle_items
  for each row execute function app.audit_row();

-- The shape of a bundle, for every writer: the bundle is a bundle, the part is not, the plan has products, at most 50 parts.
create or replace function app.product_bundle_items_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_bundle_kind text;
  v_part_kind text;
  v_part_active boolean;
  v_part_archived timestamptz;
begin
  -- outsider guard (RVW-23): a person who may not edit this business's catalog is refused by RLS (42501) right after
  -- this trigger; answering here would tell an outsider the business's plan or catalog
  if auth.uid() is not null and not app.can_edit_catalog(new.organization_id) then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    new.organization_id := old.organization_id;
    new.bundle_id := old.bundle_id;
    new.component_id := old.component_id;
    return new;
  end if;
  if not app.org_has_feature(new.organization_id, 'products') then
    raise exception 'products are not in this plan' using errcode = 'P0001', hint = 'feature:products';
  end if;
  -- both products are read under a share lock: a concurrent change of either one's kind (products_bundle_kind) waits
  select p.kind into v_bundle_kind from public.products p
   where p.organization_id = new.organization_id and p.id = new.bundle_id for share;
  select p.kind, p.is_active, p.archived_at into v_part_kind, v_part_active, v_part_archived from public.products p
   where p.organization_id = new.organization_id and p.id = new.component_id for share;
  -- a missing product: the foreign key refuses the row (23503)
  if v_bundle_kind is not null and v_bundle_kind <> 'bundle' then
    raise exception 'only a bundle has parts' using errcode = 'P0001', hint = 'product_bundle:not_bundle';
  end if;
  if v_part_kind = 'bundle' then
    raise exception 'a bundle is not a part of another bundle' using errcode = 'P0001', hint = 'product_bundle:nested';
  end if;
  if auth.uid() is not null and v_part_kind is not null and (not v_part_active or v_part_archived is not null) then
    raise exception 'the product cannot be offered' using errcode = 'P0001', hint = 'product_bundle:component';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('product_bundle_items:' || new.bundle_id::text, 0));
  if (select count(*) from public.product_bundle_items i
       where i.organization_id = new.organization_id and i.bundle_id = new.bundle_id) >= 50 then
    raise exception 'at most 50 parts in a bundle' using errcode = 'P0001', hint = 'product_bundle:max';
  end if;
  return new;
end;
$$;
revoke all on function app.product_bundle_items_check() from public, anon, authenticated;

create or replace trigger product_bundle_items_check before insert or update on public.product_bundle_items
  for each row execute function app.product_bundle_items_check();

-- A bundle with parts stays a bundle; a part of a bundle does not become one (no nesting), for every writer.
create or replace function app.products_bundle_kind() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.kind is not distinct from old.kind then
    return new;
  end if;
  if old.kind = 'bundle' and exists (select 1 from public.product_bundle_items i
                                       where i.organization_id = old.organization_id and i.bundle_id = old.id) then
    raise exception 'a bundle with parts stays a bundle' using errcode = 'P0001', hint = 'product_bundle:has_items';
  end if;
  if new.kind = 'bundle' and exists (select 1 from public.product_bundle_items i
                                       where i.organization_id = old.organization_id and i.component_id = old.id) then
    raise exception 'a part of a bundle cannot become a bundle' using errcode = 'P0001', hint = 'product_bundle:nested';
  end if;
  return new;
end;
$$;
revoke all on function app.products_bundle_kind() from public, anon, authenticated;

create or replace trigger products_bundle_kind before update of kind on public.products
  for each row execute function app.products_bundle_kind();

-- -----------------------------------------------------------------------------
-- The parts of a bundle as a document keeps them: [{name, quantity, unit_name}] per one bundle, in the page's order.
-- null when the product is not a bundle. Internal (no grants): called by the line triggers below.
-- -----------------------------------------------------------------------------
create or replace function app.bundle_snapshot(p_org uuid, p_product uuid) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select case when b.kind = 'bundle' then
    coalesce((select jsonb_agg(jsonb_build_object('name', p.name, 'quantity', i.quantity, 'unit_name', u.name)
                               order by i.position, lower(p.name), i.id)
                from public.product_bundle_items i
                join public.products p on p.organization_id = i.organization_id and p.id = i.component_id
                left join public.product_units u on u.organization_id = p.organization_id and u.id = p.unit_id
               where i.organization_id = p_org and i.bundle_id = p_product), '[]'::jsonb)
  end
    from public.products b
   where b.organization_id = p_org and b.id = p_product;
$$;
revoke all on function app.bundle_snapshot(uuid, uuid) from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Document lines
-- -----------------------------------------------------------------------------
alter table public.deal_lines add column if not exists bundle_display text;
alter table public.quote_lines add column if not exists bundle_display text;
alter table public.quote_lines add column if not exists bundle_items jsonb;
alter table public.order_lines add column if not exists bundle_display text;
alter table public.order_lines add column if not exists bundle_items jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'deal_lines_bundle_display' and conrelid = 'public.deal_lines'::regclass) then
    alter table public.deal_lines add constraint deal_lines_bundle_display check (bundle_display in ('single', 'itemised'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'quote_lines_bundle_display' and conrelid = 'public.quote_lines'::regclass) then
    alter table public.quote_lines add constraint quote_lines_bundle_display check (bundle_display in ('single', 'itemised'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'order_lines_bundle_display' and conrelid = 'public.order_lines'::regclass) then
    alter table public.order_lines add constraint order_lines_bundle_display check (bundle_display in ('single', 'itemised'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'quote_lines_bundle_items' and conrelid = 'public.quote_lines'::regclass) then
    alter table public.quote_lines add constraint quote_lines_bundle_items check (bundle_items is null or jsonb_typeof(bundle_items) = 'array');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'order_lines_bundle_items' and conrelid = 'public.order_lines'::regclass) then
    alter table public.order_lines add constraint order_lines_bundle_items check (bundle_items is null or jsonb_typeof(bundle_items) = 'array');
  end if;
end;
$$;

-- a person chooses the display on a line; the parts are server only
grant insert (bundle_display), update (bundle_display) on public.deal_lines to authenticated;
grant insert (bundle_display), update (bundle_display) on public.quote_lines to authenticated;
grant insert (bundle_display), update (bundle_display) on public.order_lines to authenticated;

-- deal lines: the choice only (the deal page reads the bundle's parts live; a deal is not a document)
create or replace function app.deal_lines_bundle() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_kind text;
begin
  -- outsider guard: RLS refuses a person who is not a member; nothing is answered here
  if auth.uid() is not null and not app.is_member(new.organization_id) then
    return new;
  end if;
  if new.product_id is not null then
    select p.kind into v_kind from public.products p where p.organization_id = new.organization_id and p.id = new.product_id;
  end if;
  if v_kind is distinct from 'bundle' then
    new.bundle_display := null;
  elsif tg_op = 'UPDATE' then
    new.bundle_display := coalesce(new.bundle_display, old.bundle_display, 'single');
  else
    new.bundle_display := coalesce(new.bundle_display, 'single');
  end if;
  return new;
end;
$$;
revoke all on function app.deal_lines_bundle() from public, anon, authenticated;

create or replace trigger deal_lines_bundle before insert or update on public.deal_lines
  for each row execute function app.deal_lines_bundle();

-- quote lines: the choice, and the parts taken once when the line is added; both frozen once the quote left draft
create or replace function app.quote_lines_bundle() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_previous uuid;
  v_status text;
  v_display text;
  v_items jsonb;
begin
  if auth.uid() is not null and not app.is_member(new.organization_id) then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    -- the product of a line never changes (quote_lines_check), and neither do its parts, for every writer
    new.bundle_items := old.bundle_items;
    if old.bundle_display is null then
      new.bundle_display := null;
      return new;
    end if;
    new.bundle_display := coalesce(new.bundle_display, old.bundle_display);
    if new.bundle_display is distinct from old.bundle_display then
      select q.status into v_status from public.quotes q where q.organization_id = new.organization_id and q.id = new.quote_id;
      if v_status is distinct from 'draft' then
        raise exception 'a sent quote does not change' using errcode = 'P0001', hint = 'quote:frozen';
      end if;
    end if;
    return new;
  end if;
  if new.product_id is not null then
    select p.kind into v_kind from public.products p where p.organization_id = new.organization_id and p.id = new.product_id;
  end if;
  if v_kind is distinct from 'bundle' then
    new.bundle_display := null;
    new.bundle_items := null;
    return new;
  end if;
  -- a new version (QUO-12) is a copy of the previous version: the matching line (same place, same product) gives its
  -- choice and its parts, so a version shows the bundle as the customer saw it
  select q.previous_id into v_previous from public.quotes q where q.organization_id = new.organization_id and q.id = new.quote_id;
  if v_previous is not null and coalesce(current_setting('app.quote_version_copy', true), '') = new.quote_id::text then
    select l.bundle_display, l.bundle_items into v_display, v_items from public.quote_lines l
     where l.organization_id = new.organization_id and l.quote_id = v_previous
       and l.position = new.position and l.product_id = new.product_id
     order by l.id limit 1;
  end if;
  new.bundle_display := coalesce(new.bundle_display, v_display, 'single');
  -- clients have no grant on bundle_items: a value here was sent by a server path
  new.bundle_items := coalesce(new.bundle_items, v_items, app.bundle_snapshot(new.organization_id, new.product_id));
  return new;
end;
$$;
revoke all on function app.quote_lines_bundle() from public, anon, authenticated;

create or replace trigger quote_lines_bundle before insert or update on public.quote_lines
  for each row execute function app.quote_lines_bundle();

-- order lines: the same; an order made from a quote keeps the quote line's choice and parts, one made from a deal its
-- choice; frozen once the order is numbered
create or replace function app.order_lines_bundle() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_order public.orders;
  v_display text;
  v_items jsonb;
begin
  if auth.uid() is not null and not app.is_member(new.organization_id) then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    new.bundle_items := old.bundle_items;
    if old.bundle_display is null then
      new.bundle_display := null;
      return new;
    end if;
    new.bundle_display := coalesce(new.bundle_display, old.bundle_display);
    if new.bundle_display is distinct from old.bundle_display then
      select * into v_order from public.orders o where o.organization_id = new.organization_id and o.id = new.order_id;
      if v_order.status is distinct from 'draft' then
        raise exception 'a numbered order does not change' using errcode = 'P0001', hint = 'order:frozen';
      end if;
    end if;
    return new;
  end if;
  if new.product_id is not null then
    select p.kind into v_kind from public.products p where p.organization_id = new.organization_id and p.id = new.product_id;
  end if;
  if v_kind is distinct from 'bundle' then
    new.bundle_display := null;
    new.bundle_items := null;
    return new;
  end if;
  if new.bundle_display is null and new.bundle_items is null then
    select * into v_order from public.orders o where o.organization_id = new.organization_id and o.id = new.order_id;
    if v_order.source = 'quote' and v_order.quote_id is not null then
      select l.bundle_display, l.bundle_items into v_display, v_items from public.quote_lines l
       where l.organization_id = new.organization_id and l.quote_id = v_order.quote_id
         and l.position = new.position and l.product_id = new.product_id
       order by l.id limit 1;
    elsif v_order.source = 'deal' and v_order.deal_id is not null then
      select l.bundle_display into v_display from public.deal_lines l
       where l.organization_id = new.organization_id and l.deal_id = v_order.deal_id
         and l.position = new.position and l.product_id = new.product_id
       order by l.id limit 1;
    end if;
    new.bundle_display := v_display;
    new.bundle_items := v_items;
  end if;
  new.bundle_display := coalesce(new.bundle_display, 'single');
  new.bundle_items := coalesce(new.bundle_items, app.bundle_snapshot(new.organization_id, new.product_id));
  return new;
end;
$$;
revoke all on function app.order_lines_bundle() from public, anon, authenticated;

create or replace trigger order_lines_bundle before insert or update on public.order_lines
  for each row execute function app.order_lines_bundle();

-- -----------------------------------------------------------------------------
-- Duplicating a quote (QUO-15): 020550's body, with only the line's bundle_display copied
-- -----------------------------------------------------------------------------
create or replace function public.quote_duplicate(p_org uuid, p_quote uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
  v_new uuid;
  v_today date;
  v_valid date;
  v_line public.quote_lines;
  v_skipped jsonb := '[]'::jsonb;
  v_skipped_lines jsonb := '[]'::jsonb;
  v_discounts boolean;
  v_dropped boolean := false;
begin
  select * into v_quote from public.quotes q where q.organization_id = p_org and q.id = p_quote;
  if not found or not app.quote_editable(p_org, v_quote.deal_id, v_quote.contact_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.org_has_feature(p_org, 'quotes') then
    raise exception 'quotes are not in this plan' using errcode = 'P0001', hint = 'feature:quotes';
  end if;

  select (now() at time zone app.intake_zone(o.timezone))::date into v_today
    from public.organizations o where o.id = p_org;
  -- the original's validity span, from today
  v_valid := case when v_quote.valid_until is null then null else v_today + (v_quote.valid_until - v_quote.quote_date) end;

  v_discounts := app.org_has_feature(p_org, 'discounts');
  v_dropped := not v_discounts and (v_quote.discount_bp is not null or v_quote.discount_agorot is not null);

  insert into public.quotes (organization_id, title, deal_id, contact_id, company_id, valid_until, prices_include_vat,
                             no_vat_reason, no_vat_note, discount_bp, discount_agorot, notes, terms, currency)
  values (p_org, left('עותק של ' || v_quote.title, 200), v_quote.deal_id, v_quote.contact_id, v_quote.company_id, v_valid,
          v_quote.prices_include_vat, v_quote.no_vat_reason, v_quote.no_vat_note,
          case when v_discounts then v_quote.discount_bp end, case when v_discounts then v_quote.discount_agorot end,
          v_quote.notes, v_quote.terms, v_quote.currency)
  returning id into v_new;
  -- a new quote takes the business's VAT mode; the copy keeps the original's, before any line is added
  update public.quotes q set prices_include_vat = v_quote.prices_include_vat
   where q.organization_id = p_org and q.id = v_new and q.prices_include_vat is distinct from v_quote.prices_include_vat;

  for v_line in
    select * from public.quote_lines l where l.organization_id = p_org and l.quote_id = p_quote order by l.position, l.id
  loop
    begin
      insert into public.quote_lines (organization_id, quote_id, position, kind, product_id, name, description, quantity,
                                      unit_price_agorot, discount_bp, discount_agorot, vat_exempt, billing, is_optional,
                                      optional_selected, price_source, price_list_id, currency, bundle_display)
      values (p_org, v_new, v_line.position, v_line.kind, v_line.product_id, v_line.name, v_line.description, v_line.quantity,
              v_line.unit_price_agorot, v_line.discount_bp, v_line.discount_agorot, v_line.vat_exempt, v_line.billing,
              v_line.is_optional, v_line.optional_selected, v_line.price_source, v_line.price_list_id, v_line.currency,
              -- PRD-09: a bundle keeps its display choice; its parts are taken from the catalog again (a new quote)
              v_line.bundle_display);
    exception when sqlstate 'P0001' or integrity_constraint_violation or insufficient_privilege then
      -- the rules refuse this line today (quote_lines_check: P0001; a constraint or a foreign key: class 23; RLS: 42501):
      -- leave it out and name it. Anything else is not a refusal and fails the whole copy.
      v_skipped := v_skipped || to_jsonb(v_line.name);
      -- QUO-15 (owner, 19 October 2026): the screen offers to add an item line as a free line, read again by its id
      v_skipped_lines := v_skipped_lines || jsonb_build_array(jsonb_build_object('id', v_line.id, 'name', v_line.name, 'kind', v_line.kind));
    end;
  end loop;

  insert into public.quote_payment_steps (organization_id, quote_id, position, name, percent_bp, due_date, milestone)
  select s.organization_id, v_new, s.position, s.name, s.percent_bp, s.due_date, s.milestone
    from public.quote_payment_steps s
   where s.organization_id = p_org and s.quote_id = p_quote
   order by s.position, s.id;

  return jsonb_build_object('quote', v_new, 'skipped', v_skipped, 'skipped_lines', v_skipped_lines, 'discount_dropped', v_dropped);
end;
$$;
revoke all on function public.quote_duplicate(uuid, uuid) from public, anon;
grant execute on function public.quote_duplicate(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- The customer's pages: an itemised bundle line lists its parts. quote_public is 021128's body (the per-sender limit) and order_public 021119's,
-- each with only 'components' added to a line; not-found rules, limits and status pages unchanged (test 253 pins the md5).
-- -----------------------------------------------------------------------------
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
  -- TAX-02: the bank details stored on the quote when it was sent, when the design shows them
  v_show_bank boolean;
  v_lines jsonb;
  v_built_with boolean;
  v_schedule jsonb;
  -- QUO-12: the quote the link was made for, when the page shows a newer version of it
  v_opened public.quotes;
  v_next public.quotes;
  -- OPS-02 (owner (41) ב): the per-sender view limit
  v_sender text;
  v_bucket integer;
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
  -- OPS-02 (owner, 2 November 2026, answer (41) ב): 60 views per sender in 10 minutes, as order_public and statement_public,
  -- counted after the token lookup and the link's window. The sender is the server's keyed IP hash (FXS-11 scope 'quote'),
  -- handed over in the request header x-crm-sender (app.public_sender_header, 021127) and scoped to the link's quote by
  -- app.quote_link_sender; no header = not counted (the signed PDF's own read, quote_public_answer, a page older than this file).
  -- Only a bucket number is kept, never the hash.
  v_sender := app.quote_link_sender(v_link.quote_id, app.public_sender_header());
  if v_sender is not null then
    v_bucket := ((hashtextextended(v_sender, 0) % 1024) + 1024) % 1024;
    insert into app.quote_link_view_counts as vc (organization_id, quote_id, bucket, window_start, views)
    values (v_link.organization_id, v_link.quote_id, v_bucket, now(), 1)
    on conflict (quote_id, bucket) do update
      set window_start = case when vc.window_start > now() - interval '10 minutes' then vc.window_start else now() end,
          views = case when vc.window_start > now() - interval '10 minutes' then vc.views + 1 else 1 end
    returning vc.views into v_count;
    if v_count > 60 then
      return jsonb_build_object('rate_limited', true);
    end if;
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
  v_show_bank := coalesce(v_design.show_bank_details_quote, true);

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
           'total_agorot', l.total_agorot,
           -- PRD-09: an itemised bundle lists its parts as kept on the line when it was added (names and quantities, no prices)
           'components', case when l.bundle_display = 'itemised' then l.bundle_items end) order by l.position, l.id), '[]'::jsonb)
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
      'show_bank_details_quote', v_show_bank,
      'accent_color', v_design.accent_color),
    'brand', jsonb_build_object('logo', case when v_show_logo then v_org.logo_path end, 'color', v_org.brand_color),
    'built_with', v_built_with,
    -- TAX-02: the business's bank details for a transfer, as stored on the quote when it was sent (never the live settings);
    -- only when the design shows them and the quote has them
    'bank', case when v_show_bank and v_quote.bank_details is not null then jsonb_build_object(
                   'bank_name', v_quote.bank_details ->> 'bank_name',
                   'bank_branch', v_quote.bank_details ->> 'bank_branch',
                   'bank_account', v_quote.bank_details ->> 'bank_account',
                   'bank_account_name', v_quote.bank_details ->> 'bank_account_name') end,
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

create or replace function public.order_public(p_token text, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_link app.order_links;
  v_order public.orders;
  v_count integer;
  v_bucket integer;
  v_views integer;
  v_design public.quote_designs;
  v_settings public.org_document_settings;
  v_org public.organizations;
  v_decision public.order_decisions;
  v_show_details boolean;
  v_show_logo boolean;
  -- TAX-02: the bank details stored on the order when it was numbered, when the design shows them
  v_show_bank boolean;
  v_lines jsonb;
  v_schedule jsonb;
  v_built_with boolean;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'order not found' using errcode = 'P0002';
  end if;
  select * into v_link from app.order_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then
    raise exception 'order not found' using errcode = 'P0002';
  end if;
  select * into v_order from public.orders o where o.organization_id = v_link.organization_id and o.id = v_link.order_id;
  if not found or not app.order_link_usable(v_order) then
    raise exception 'order not found' using errcode = 'P0002';
  end if;

  -- 120 views per link in 10 minutes; counted first, so the limit holds under parallel load
  update app.order_links l
     set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
         window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end
   where l.order_id = v_link.order_id
  returning l.window_count into v_count;
  if v_count > 120 then
    return jsonb_build_object('rate_limited', true);
  end if;
  -- FXS-11: 60 views per sender in 10 minutes, by the server's keyed IP hash scoped to this order
  if p_ip_hash is not null then
    v_bucket := ((hashtextextended(app.order_link_sender(v_order.id, p_ip_hash), 0) % 1024) + 1024) % 1024;
    insert into app.order_link_view_counts as vc (order_id, bucket, window_start, views)
    values (v_order.id, v_bucket, now(), 1)
    on conflict (order_id, bucket) do update
      set window_start = case when vc.window_start > now() - interval '10 minutes' then vc.window_start else now() end,
          views = case when vc.window_start > now() - interval '10 minutes' then vc.views + 1 else 1 end
    returning vc.views into v_views;
    if v_views > 60 then
      return jsonb_build_object('rate_limited', true);
    end if;
  end if;

  select * into v_org from public.organizations o where o.id = v_order.organization_id;
  select * into v_design from public.quote_designs d where d.organization_id = v_order.organization_id;
  select * into v_settings from public.org_document_settings s where s.organization_id = v_order.organization_id;
  -- QUO-05: no design row = the defaults (logo and business details shown)
  v_show_details := coalesce(v_design.show_business_details, true);
  v_show_logo := coalesce(v_design.show_logo, true);
  v_show_bank := coalesce(v_design.show_bank_details_order, true);

  -- a cancelled order: its state only, no prices or lines (the one rule for a sent link)
  if v_order.status = 'cancelled' then
    return jsonb_build_object('status_page', jsonb_build_object(
      'state', 'cancelled',
      'number', v_order.number_display,
      -- documents use the registered name when set (owner)
      'business', coalesce(nullif(btrim(v_settings.legal_name), ''), v_org.name),
      'logo', case when v_show_logo then v_org.logo_path end,
      'color', coalesce(v_design.accent_color, v_org.brand_color),
      'phone', coalesce(nullif(btrim(v_settings.phone), ''), nullif(btrim(v_org.phone), ''))));
  end if;

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
           'total_agorot', l.total_agorot,
           -- PRD-09: an itemised bundle lists its parts as kept on the line when it was added (names and quantities, no prices)
           'components', case when l.bundle_display = 'itemised' then l.bundle_items end) order by l.position, l.id), '[]'::jsonb)
    into v_lines
    from public.order_lines l
   where l.organization_id = v_order.organization_id and l.order_id = v_order.id;

  -- ORD-04: each step with its share of the total (cumulative shares, half up, = scheduleAmounts())
  select coalesce(jsonb_agg(jsonb_build_object(
           'name', r.name,
           'percent_bp', r.percent_bp,
           'due_date', r.due_date,
           'milestone', r.milestone,
           'amount_agorot', round(v_order.total_agorot::numeric * r.cum / 10000) - round(v_order.total_agorot::numeric * (r.cum - r.percent_bp) / 10000))
         order by r.position, r.id), '[]'::jsonb)
    into v_schedule
    from (select s.id, s.position, s.name, s.percent_bp, s.due_date, s.milestone,
                 sum(s.percent_bp) over (order by s.position, s.id) as cum
            from public.order_payment_steps s
           where s.organization_id = v_order.organization_id and s.order_id = v_order.id) r;

  select * into v_decision from public.order_decisions d where d.organization_id = v_order.organization_id and d.order_id = v_order.id;

  begin
    v_built_with := coalesce(app.show_built_with(v_order.organization_id), true);
  exception when others then
    v_built_with := true;
  end;

  return jsonb_build_object(
    'order', jsonb_build_object(
      'number', v_order.number_display,
      'status', v_order.status,
      'order_date', v_order.order_date,
      'delivery_date', v_order.delivery_date,
      'shipping_address', v_order.shipping_address,
      'notes', v_order.notes,
      'prices_include_vat', v_order.prices_include_vat,
      'no_vat_reason', v_order.no_vat_reason,
      'no_vat_note', v_order.no_vat_note,
      'discount_bp', v_order.discount_bp,
      'discount_agorot', v_order.discount_agorot,
      'vat_rate_bp', v_order.vat_rate_bp,
      'subtotal_agorot', v_order.subtotal_agorot,
      'discount_total_agorot', v_order.discount_total_agorot,
      'net_total_agorot', v_order.net_total_agorot,
      'vat_agorot', v_order.vat_agorot,
      'total_agorot', v_order.total_agorot,
      'currency', v_order.currency),
    -- the customer as named when the order was numbered (ORD-03); never the live record
    'customer', jsonb_build_object('name', v_order.customer_name),
    'lines', v_lines,
    'schedule', v_schedule,
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
      'show_bank_details_order', v_show_bank,
      'accent_color', v_design.accent_color),
    'brand', jsonb_build_object('logo', case when v_show_logo then v_org.logo_path end, 'color', v_org.brand_color),
    'built_with', v_built_with,
    -- TAX-02: the business's bank details for a transfer, as stored on the order when it was numbered (never the live
    -- settings); only when the design shows them and the order has them
    'bank', case when v_show_bank and v_order.bank_details is not null then jsonb_build_object(
                   'bank_name', v_order.bank_details ->> 'bank_name',
                   'bank_branch', v_order.bank_details ->> 'bank_branch',
                   'bank_account', v_order.bank_details ->> 'bank_account',
                   'bank_account_name', v_order.bank_details ->> 'bank_account_name') end,
    -- the customer's answer: what and when only
    'decision', case when v_decision.id is not null
                     then jsonb_build_object('decision', v_decision.decision, 'decided_at', v_decision.decided_at) end,
    -- what an answer must name, while the order waits for one
    'fingerprint', case when v_order.status = 'new' and v_decision.id is null then app.order_fingerprint(v_order) end,
    -- ORD-05 PDF (owner's answer (1) ב): the customer may download the order's stored PDF
    'pdf', exists (select 1 from public.files f
                    where f.organization_id = v_order.organization_id and f.order_id = v_order.id
                      and f.unconfirmed_since is null and f.sha256 is not null));
end;
$$;
revoke all on function public.order_public(text, text) from public, anon, authenticated;
grant execute on function public.order_public(text, text) to service_role;
