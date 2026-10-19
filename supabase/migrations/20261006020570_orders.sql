-- =============================================================================
-- Orders: ORD-01 (an order from an accepted quote, a won deal, or by hand), ORD-03 (its running number) and ORD-02's
-- status column. Owner's answers of 19 October 2026 (DECISIONS.md, "הזמנות: שאלות לפני הבנייה").
-- =============================================================================
-- SPEC-ADDITIONS 6.3: an order is an internal document, not an accounting one. The module is optional: off by default,
-- switched on in the business settings (org_modules.orders_enabled, only while the plan has the `orders` key, hint
-- feature:orders); turning it off only hides screens. Billing and payment status come with DOC/PAY.
--
-- public.orders, one row per order:
--   status            draft | new | in_progress | partly_delivered | delivered | cancelled. A manual order starts as a
--                     draft (no number) and is numbered when confirmed (public.order_confirm). An order made from an
--                     accepted quote (public.order_from_quote) or a won deal (public.order_from_deal) is created
--                     confirmed and numbered at once. A person moves a numbered order between the ORD-02 states; it
--                     never returns to draft (order:no_redraft) and a cancelled order stays cancelled
--                     (order:cancelled). Only a draft is deleted; a numbered order is never deleted, only cancelled.
--   number,           from app.next_document_number(org, 'order') (QUO-03's gap-free series), once.
--   number_display
--   source            manual | quote | deal (server only)
--   quote_id          the accepted quote it was made from: one order per quote (orders_quote_once). An accepted
--                     addendum (GAP-10) makes its own order, linked to the original quote's order (original_order_id).
--   deal_id           optional; set once, on insert. contact_id, company_id: the customer, at least one (hint
--                     order:customer, checked for a person's write and when confirming). A purge never removes a
--                     numbered order: it is detached first (former_*_id; customer_deleted_at when nothing is left);
--                     a draft goes with its deal, else with the contact it alone belongs to, else with its company.
--   delivery_contact_id  the contact for delivery (a live contact the caller reads, hint order:contact).
--   delivery_date, shipping_address, notes   editable while the order is not cancelled. The shipping address is
--                     copied once when the order is made: the contact's shipping_address, else its company's (CON-08).
--   order_date        the business's day when it was numbered (a draft: the day it was made).
--   prices_include_vat, no_vat_reason, no_vat_note, discount_bp, discount_agorot, vat_rate_bp and the totals: as in
--                     quotes; a draft is worked out again on every write; a numbered order keeps its amounts and the
--                     inputs they came from for every writer (order:frozen). An order from a quote keeps the quote's
--                     own VAT rate (owner: lines and prices as accepted; a price changes only through an addendum).
--   customer_name     the customer as named when numbered (the rule of quote_send, CON-08 order).
--
-- public.order_lines: kind item | group, product, name, description, unit, quantity, price, discount, VAT exemption,
-- billing, price_source and the price list's name, the line total. Written by a person only while the order is a draft;
-- copies made by order_from_quote / order_from_deal are server writes. 200 per order.
--
-- Rights (22.9: a child record inherits its parent's visibility; owner (6): like quotes):
-- * read: the caller reads the order's deal, else its contact, else its company; an order left with none of them is
--   read by owners, admins and managers by role (as detached quotes);
-- * write: app.order_editable = may edit that live deal, else contact, else company, in a writable business; insert
--   (drafts only) also needs the `orders` flag; delete only drafts. A viewer seat reads only.
--
-- Also here (22.9 "after every new module"): merges carry orders to the kept record (through the `merged` entry, as
-- CON-05 does, until app.merge_move_links takes it over); privacy erasure empties a detached order's personal details
-- (app.audit_erase_core, from 020520); sample removal and undo of one's own import count an order as real work
-- (app.sample_untouched from 020315, app.import_record_worked from 020450). Record handover leaves an order's owner_id
-- (its rights follow the deal or contact, which do move). Every statement is safe to run twice. No drops, no row removal.

-- ----------------------------------------------------------------------------
-- The module switch
-- ----------------------------------------------------------------------------
alter table public.org_modules add column if not exists orders_enabled boolean not null default false;
-- the one-time offer to switch orders on, shown when a quote is accepted (owner), is closed for the whole business
alter table public.org_modules add column if not exists orders_offer_closed_at timestamptz;
grant insert (orders_enabled, orders_offer_closed_at) on public.org_modules to authenticated;
grant update (orders_enabled, orders_offer_closed_at) on public.org_modules to authenticated;

-- turning orders on needs the plan's `orders` key (the other switches are unchanged)
create or replace function app.org_modules_orders_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  if new.orders_enabled and (tg_op = 'INSERT' or not old.orders_enabled)
     and not app.org_has_feature(new.organization_id, 'orders') then
    raise exception 'orders are not in this plan' using errcode = 'P0001', hint = 'feature:orders';
  end if;
  return new;
end;
$$;
revoke all on function app.org_modules_orders_check() from public, anon, authenticated, service_role;

create or replace trigger org_modules_orders_check before insert or update on public.org_modules
  for each row execute function app.org_modules_orders_check();

-- ----------------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------------
create table if not exists public.orders (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete cascade,
  status                text not null default 'draft'
                        check (status in ('draft', 'new', 'in_progress', 'partly_delivered', 'delivered', 'cancelled')),
  source                text not null default 'manual' check (source in ('manual', 'quote', 'deal')),
  number                bigint,
  number_display        text,
  quote_id              uuid,
  original_order_id     uuid,
  deal_id               uuid,
  contact_id            uuid,
  company_id            uuid,
  delivery_contact_id   uuid,
  owner_id              uuid references auth.users (id) on delete set null,
  order_date            date not null default current_date,
  delivery_date         date,
  shipping_address      text check (shipping_address is null or char_length(shipping_address) <= 500),
  notes                 text check (notes is null or char_length(notes) <= 4000),
  prices_include_vat    boolean not null default false,
  no_vat_reason         text check (no_vat_reason in ('eilat', 'abroad', 'other')),
  no_vat_note           text check (no_vat_note is null or char_length(btrim(no_vat_note)) between 1 and 200),
  discount_bp           integer check (discount_bp is null or discount_bp between 1 and 10000),
  discount_agorot       bigint check (discount_agorot is null or discount_agorot between 1 and 1000000000000),
  vat_rate_bp           integer,
  subtotal_agorot       bigint not null default 0,
  discount_total_agorot bigint not null default 0,
  net_total_agorot      bigint not null default 0,
  vat_agorot            bigint not null default 0,
  total_agorot          bigint not null default 0,
  currency              text not null default 'ILS' check (currency = 'ILS'),
  customer_name         text,
  confirmed_at          timestamptz,
  cancelled_at          timestamptz,
  former_deal_id        uuid,
  former_contact_id     uuid,
  former_company_id     uuid,
  customer_deleted_at   timestamptz,
  created_by            uuid references auth.users (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (organization_id, id),
  constraint orders_number_once unique (organization_id, number),
  constraint orders_one_discount check (discount_bp is null or discount_agorot is null),
  constraint orders_no_vat_note check ((no_vat_reason = 'other') = (no_vat_note is not null)),
  constraint orders_no_vat_mode check (no_vat_reason is null or not prices_include_vat),
  -- a draft has no number; every other order has one
  constraint orders_numbered check ((status = 'draft') = (number is null)),
  constraint orders_source_quote check ((source = 'quote') = (quote_id is not null)),
  constraint orders_deal_fk foreign key (organization_id, deal_id)
    references public.deals (organization_id, id) on delete cascade,
  constraint orders_contact_fk foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete cascade,
  constraint orders_company_fk foreign key (organization_id, company_id)
    references public.companies (organization_id, id) on delete cascade,
  constraint orders_delivery_contact_fk foreign key (organization_id, delivery_contact_id)
    references public.contacts (organization_id, id) on delete set null (delivery_contact_id),
  constraint orders_quote_fk foreign key (organization_id, quote_id)
    references public.quotes (organization_id, id) on delete set null (quote_id),
  constraint orders_original_fk foreign key (organization_id, original_order_id)
    references public.orders (organization_id, id) on delete set null (original_order_id)
);

-- one order per quote (owner (3))
create unique index if not exists orders_quote_once on public.orders (organization_id, quote_id) where quote_id is not null;
create index if not exists orders_quote_idx on public.orders (organization_id, quote_id);
create index if not exists orders_deal_idx on public.orders (organization_id, deal_id);
create index if not exists orders_contact_idx on public.orders (organization_id, contact_id);
create index if not exists orders_company_idx on public.orders (organization_id, company_id);
create index if not exists orders_delivery_contact_idx on public.orders (organization_id, delivery_contact_id);
create index if not exists orders_original_idx on public.orders (organization_id, original_order_id);
create index if not exists orders_former_deal_idx on public.orders (organization_id, former_deal_id) where former_deal_id is not null;
create index if not exists orders_former_contact_idx on public.orders (organization_id, former_contact_id) where former_contact_id is not null;
create index if not exists orders_former_company_idx on public.orders (organization_id, former_company_id) where former_company_id is not null;
create index if not exists orders_org_created_idx on public.orders (organization_id, created_at desc);

create table if not exists public.order_lines (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  order_id           uuid not null,
  position           integer not null default 0 check (position between 0 and 100000),
  kind               text not null default 'item' check (kind in ('item', 'group')),
  product_id         uuid,
  name               text not null check (char_length(btrim(name)) between 1 and 300),
  description        text check (description is null or char_length(description) <= 2000),
  unit_name          text,
  quantity           numeric not null default 1,
  unit_price_agorot  bigint not null default 0 check (unit_price_agorot between 0 and 1000000000000),
  discount_bp        integer check (discount_bp is null or discount_bp between 1 and 10000),
  discount_agorot    bigint check (discount_agorot is null or discount_agorot between 1 and 1000000000000),
  vat_exempt         boolean not null default false,
  billing            text not null default 'one_time' check (billing in ('one_time', 'monthly', 'quarterly', 'yearly')),
  price_source       text not null default 'manual' check (price_source in ('product', 'price_list', 'manual')),
  price_list_name    text,
  total_agorot       bigint not null default 0,
  currency           text not null default 'ILS' check (currency = 'ILS'),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (organization_id, id),
  constraint order_lines_order_fk foreign key (organization_id, order_id)
    references public.orders (organization_id, id) on delete cascade,
  -- no action: a product on a line cannot be removed, only archived (PRD-02)
  constraint order_lines_product_fk foreign key (organization_id, product_id)
    references public.products (organization_id, id),
  constraint order_lines_quantity check (quantity > 0 and quantity <= 1000000 and quantity = round(quantity, 3)),
  constraint order_lines_one_discount check (discount_bp is null or discount_agorot is null),
  constraint order_lines_group_shape check (
    kind = 'item'
    or (product_id is null and discount_bp is null and discount_agorot is null
        and unit_price_agorot = 0 and quantity = 1 and price_source = 'manual'))
);

create index if not exists order_lines_order_idx on public.order_lines (organization_id, order_id, position);
create index if not exists order_lines_product_idx on public.order_lines (organization_id, product_id);

alter table public.orders enable row level security;
alter table public.order_lines enable row level security;

revoke all on public.orders from anon, authenticated;
grant select, delete on public.orders to authenticated;
grant insert (organization_id, deal_id, contact_id, company_id, delivery_contact_id, delivery_date, shipping_address, notes,
              prices_include_vat, no_vat_reason, no_vat_note, discount_bp, discount_agorot, currency)
  on public.orders to authenticated;
grant update (status, contact_id, company_id, delivery_contact_id, delivery_date, shipping_address, notes, prices_include_vat,
              no_vat_reason, no_vat_note, discount_bp, discount_agorot)
  on public.orders to authenticated;

revoke all on public.order_lines from anon, authenticated;
grant select, delete on public.order_lines to authenticated;
grant insert (organization_id, order_id, position, kind, product_id, name, description, quantity, unit_price_agorot,
              discount_bp, discount_agorot, vat_exempt, billing, currency)
  on public.order_lines to authenticated;
grant update (position, name, description, quantity, unit_price_agorot, discount_bp, discount_agorot, vat_exempt, billing)
  on public.order_lines to authenticated;

-- ----------------------------------------------------------------------------
-- Who may write an order: the one who may edit its deal, else its contact, else its company
-- ----------------------------------------------------------------------------
create or replace function app.order_editable(p_org uuid, p_deal uuid, p_contact uuid, p_company uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select case
    when p_deal is not null or p_contact is not null then app.quote_editable(p_org, p_deal, p_contact)
    when p_company is not null then exists (
      select 1 from public.companies c
       where c.organization_id = p_org and c.id = p_company and c.deleted_at is null
         and app.can_edit_record(c.organization_id, c.owner_id, c.team_id))
    else false
  end;
$$;
revoke all on function app.order_editable(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function app.order_editable(uuid, uuid, uuid, uuid) to authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'orders' and policyname = 'orders_select') then
    create policy orders_select on public.orders for select to authenticated
      using (case when orders.deal_id is not null
                  then exists (select 1 from public.deals d where d.organization_id = orders.organization_id and d.id = orders.deal_id)
                  when orders.contact_id is not null
                  then exists (select 1 from public.contacts c where c.organization_id = orders.organization_id and c.id = orders.contact_id)
                  when orders.company_id is not null
                  then exists (select 1 from public.companies c where c.organization_id = orders.organization_id and c.id = orders.company_id)
                  else coalesce(app.role_in(orders.organization_id) in ('owner', 'admin', 'manager'), false)
             end);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'orders' and policyname = 'orders_insert') then
    create policy orders_insert on public.orders for insert to authenticated
      with check (app.org_has_feature(organization_id, 'orders')
                  and app.order_editable(organization_id, deal_id, contact_id, company_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'orders' and policyname = 'orders_update') then
    create policy orders_update on public.orders for update to authenticated
      using (app.order_editable(organization_id, deal_id, contact_id, company_id))
      with check (app.order_editable(organization_id, deal_id, contact_id, company_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'orders' and policyname = 'orders_delete') then
    create policy orders_delete on public.orders for delete to authenticated
      using (status = 'draft' and app.order_editable(organization_id, deal_id, contact_id, company_id));
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'order_lines' and policyname = 'order_lines_select') then
    create policy order_lines_select on public.order_lines for select to authenticated
      using (exists (select 1 from public.orders o where o.organization_id = order_lines.organization_id and o.id = order_lines.order_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'order_lines' and policyname = 'order_lines_insert') then
    create policy order_lines_insert on public.order_lines for insert to authenticated
      with check (exists (select 1 from public.orders o
                           where o.organization_id = order_lines.organization_id and o.id = order_lines.order_id
                             and o.status = 'draft' and app.order_editable(o.organization_id, o.deal_id, o.contact_id, o.company_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'order_lines' and policyname = 'order_lines_update') then
    create policy order_lines_update on public.order_lines for update to authenticated
      using (exists (select 1 from public.orders o
                      where o.organization_id = order_lines.organization_id and o.id = order_lines.order_id
                        and o.status = 'draft' and app.order_editable(o.organization_id, o.deal_id, o.contact_id, o.company_id)))
      with check (exists (select 1 from public.orders o
                           where o.organization_id = order_lines.organization_id and o.id = order_lines.order_id
                             and o.status = 'draft' and app.order_editable(o.organization_id, o.deal_id, o.contact_id, o.company_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'order_lines' and policyname = 'order_lines_delete') then
    create policy order_lines_delete on public.order_lines for delete to authenticated
      using (exists (select 1 from public.orders o
                      where o.organization_id = order_lines.organization_id and o.id = order_lines.order_id
                        and o.status = 'draft' and app.order_editable(o.organization_id, o.deal_id, o.contact_id, o.company_id)));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- The order: server values, states and totals
-- ----------------------------------------------------------------------------
create or replace function app.orders_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_zone text;
  v_rate integer;
  v_lines jsonb;
  v_totals jsonb;
  v_contact_shipping text;
  v_company_shipping text;
  v_person boolean := auth.uid() is not null and coalesce(current_setting('app.order_server', true), '') <> 'on';
begin
  -- outsider guard: a person who may not edit the order's parent is refused by RLS (42501)
  if v_person and not app.order_editable(new.organization_id, new.deal_id, new.contact_id, new.company_id) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if v_person then
      if not app.org_has_feature(new.organization_id, 'orders') then
        raise exception 'orders are not in this plan' using errcode = 'P0001', hint = 'feature:orders';
      end if;
      -- a person makes a manual draft; numbered orders come from the server functions only
      new.status := 'draft';
      new.source := 'manual';
      new.quote_id := null;
      new.original_order_id := null;
      new.number := null;
      new.number_display := null;
      new.customer_name := null;
      new.prices_include_vat := coalesce((select s.prices_include_vat from public.org_document_settings s
                                           where s.organization_id = new.organization_id), false)
                                and new.no_vat_reason is null;
    end if;
    new.owner_id := coalesce(new.owner_id, auth.uid());
    new.created_by := coalesce(new.created_by, auth.uid());
    select o.timezone into v_zone from public.organizations o where o.id = new.organization_id;
    new.order_date := (now() at time zone coalesce(v_zone, 'Asia/Jerusalem'))::date;
    -- the customer of the deal, else the contact's company
    if new.deal_id is not null then
      select coalesce(new.contact_id, d.contact_id), coalesce(new.company_id, d.company_id)
        into new.contact_id, new.company_id
        from public.deals d where d.organization_id = new.organization_id and d.id = new.deal_id;
    end if;
    if new.company_id is null and new.contact_id is not null then
      new.company_id := (select c.company_id from public.contacts c
                          where c.organization_id = new.organization_id and c.id = new.contact_id);
    end if;
    -- the shipping address is copied once (owner (5)): the contact's, else its company's
    if new.shipping_address is null then
      select nullif(btrim(c.shipping_address), '') into v_contact_shipping from public.contacts c
       where c.organization_id = new.organization_id and c.id = new.contact_id;
      select nullif(btrim(co.shipping_address), '') into v_company_shipping from public.companies co
       where co.organization_id = new.organization_id and co.id = new.company_id;
      new.shipping_address := left(coalesce(v_contact_shipping, v_company_shipping), 500);
    end if;
  else
    new.organization_id := old.organization_id;
    new.deal_id := case when v_person then old.deal_id else new.deal_id end;
    new.owner_id := old.owner_id;
    new.created_by := old.created_by;
    new.source := old.source;
    new.quote_id := case when v_person then old.quote_id else new.quote_id end;
    new.original_order_id := old.original_order_id;
    if v_person then
      new.number := old.number;
      new.number_display := old.number_display;
      new.customer_name := old.customer_name;
      new.order_date := old.order_date;
      -- the states of ORD-02: a person never makes or unmakes a draft, and a cancelled order stays cancelled
      if old.status = 'draft' and new.status <> 'draft' then
        raise exception 'a draft is confirmed with order_confirm' using errcode = 'P0001', hint = 'order:confirm';
      end if;
      if old.status <> 'draft' and new.status = 'draft' then
        raise exception 'a numbered order never returns to draft' using errcode = 'P0001', hint = 'order:no_redraft';
      end if;
      if old.status = 'cancelled' and new.status <> 'cancelled' then
        raise exception 'a cancelled order stays cancelled' using errcode = 'P0001', hint = 'order:cancelled';
      end if;
      -- a numbered order keeps its customer and the inputs of its amounts
      if old.status <> 'draft'
         and (new.contact_id is distinct from old.contact_id or new.company_id is distinct from old.company_id) then
        raise exception 'the customer of a numbered order cannot change' using errcode = 'P0001', hint = 'order:frozen';
      end if;
    end if;
    if old.status <> 'draft'
       and (new.discount_bp is distinct from old.discount_bp
            or new.discount_agorot is distinct from old.discount_agorot
            or new.prices_include_vat is distinct from old.prices_include_vat
            or new.no_vat_reason is distinct from old.no_vat_reason
            or new.no_vat_note is distinct from old.no_vat_note) then
      raise exception 'the prices of a numbered order cannot change' using errcode = 'P0001', hint = 'order:frozen';
    end if;
    if new.prices_include_vat is distinct from old.prices_include_vat
       and exists (select 1 from public.order_lines l
                    where l.organization_id = new.organization_id and l.order_id = new.id and l.kind = 'item') then
      raise exception 'the VAT mode of an order with lines cannot change' using errcode = 'P0001', hint = 'order:vat_locked';
    end if;
    if new.status = 'cancelled' and old.status <> 'cancelled' then
      new.cancelled_at := now();
    end if;
  end if;

  -- a person's order names a customer (owner (5))
  if v_person and new.contact_id is null and new.company_id is null then
    raise exception 'an order needs a contact or a company' using errcode = 'P0001', hint = 'order:customer';
  end if;
  if v_person and (new.discount_bp is not null or new.discount_agorot is not null)
     and (tg_op = 'INSERT' or new.discount_bp is distinct from old.discount_bp or new.discount_agorot is distinct from old.discount_agorot)
     and not app.org_has_feature(new.organization_id, 'discounts') then
    raise exception 'discounts are not in this plan' using errcode = 'P0001', hint = 'feature:discounts';
  end if;

  -- a numbered order keeps the amounts and rate it was numbered with
  if tg_op = 'UPDATE' and old.status <> 'draft' then
    new.vat_rate_bp := old.vat_rate_bp;
    new.subtotal_agorot := old.subtotal_agorot;
    new.discount_total_agorot := old.discount_total_agorot;
    new.net_total_agorot := old.net_total_agorot;
    new.vat_agorot := old.vat_agorot;
    new.total_agorot := old.total_agorot;
    return new;
  end if;

  -- totals by the one totals rule (TAX-05); an order from a quote keeps the quote's rate (set by the server)
  v_rate := case when new.no_vat_reason is not null then 0
                 when new.source = 'quote' then new.vat_rate_bp
                 else app.org_document_vat_rate(new.organization_id, new.order_date) end;
  if tg_op = 'INSERT' then
    v_lines := '[]'::jsonb;
  else
    select coalesce(jsonb_agg(jsonb_build_object(
             'quantity', l.quantity,
             'unit_price_agorot', l.unit_price_agorot,
             'discount_bp', l.discount_bp,
             'discount_agorot', l.discount_agorot,
             'vat_exempt', l.vat_exempt) order by l.position, l.id), '[]'::jsonb)
      into v_lines
      from public.order_lines l
     where l.organization_id = new.organization_id and l.order_id = new.id and l.kind = 'item';
  end if;
  v_totals := app.document_totals(v_lines, coalesce(v_rate, 0), new.prices_include_vat, new.discount_bp, new.discount_agorot);
  new.vat_rate_bp := v_rate;
  new.subtotal_agorot := (v_totals ->> 'subtotal_agorot')::bigint;
  new.discount_total_agorot := (v_totals ->> 'document_discount_agorot')::bigint;
  new.net_total_agorot := (v_totals ->> 'net_total_agorot')::bigint;
  new.vat_agorot := (v_totals ->> 'vat_agorot')::bigint;
  new.total_agorot := (v_totals ->> 'total_agorot')::bigint;
  return new;
end;
$$;
revoke all on function app.orders_check() from public, anon, authenticated, service_role;

create or replace trigger orders_check before insert or update on public.orders
  for each row execute function app.orders_check();

-- A person links only a contact / company they read and that is not in the bin (security invoker: the reads run
-- under the caller's RLS). The deal's own contact and company, and the contact's company, are always allowed.
create or replace function app.orders_links() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if new.contact_id is not null and (tg_op = 'INSERT' or new.contact_id is distinct from old.contact_id)
     and not exists (select 1 from public.contacts c
                      where c.organization_id = new.organization_id and c.id = new.contact_id and c.deleted_at is null)
     and not (new.deal_id is not null and exists (
                select 1 from public.deals d
                 where d.organization_id = new.organization_id and d.id = new.deal_id and d.contact_id = new.contact_id)) then
    raise exception 'the contact cannot be linked' using errcode = 'P0001', hint = 'order:contact';
  end if;
  if new.delivery_contact_id is not null and (tg_op = 'INSERT' or new.delivery_contact_id is distinct from old.delivery_contact_id)
     and not exists (select 1 from public.contacts c
                      where c.organization_id = new.organization_id and c.id = new.delivery_contact_id and c.deleted_at is null) then
    raise exception 'the delivery contact cannot be linked' using errcode = 'P0001', hint = 'order:contact';
  end if;
  if new.company_id is not null and (tg_op = 'INSERT' or new.company_id is distinct from old.company_id)
     and not exists (select 1 from public.companies c
                      where c.organization_id = new.organization_id and c.id = new.company_id and c.deleted_at is null)
     and not (new.deal_id is not null and exists (
                select 1 from public.deals d
                 where d.organization_id = new.organization_id and d.id = new.deal_id and d.company_id = new.company_id))
     and not (new.contact_id is not null and exists (
                select 1 from public.contacts c
                 where c.organization_id = new.organization_id and c.id = new.contact_id and c.company_id = new.company_id)) then
    raise exception 'the company cannot be linked' using errcode = 'P0001', hint = 'order:company';
  end if;
  return new;
end;
$$;
revoke all on function app.orders_links() from public, anon;
grant execute on function app.orders_links() to authenticated;

create or replace trigger orders_links before insert or update on public.orders
  for each row execute function app.orders_links();

-- Only a draft is deleted, by every writer but a purge of its parent (the cascade) and the business's own removal
create or replace function app.orders_delete_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if old.status <> 'draft' and app.org_exists(old.organization_id)
     and coalesce(current_setting('app.order_server', true), '') <> 'on' then
    raise exception 'a numbered order is cancelled, never deleted' using errcode = 'P0001', hint = 'order:numbered';
  end if;
  return old;
end;
$$;
revoke all on function app.orders_delete_guard() from public, anon, authenticated, service_role;

create or replace trigger orders_delete_guard before delete on public.orders
  for each row execute function app.orders_delete_guard();

create or replace trigger orders_touch before insert or update on public.orders
  for each row execute function app.touch_row();
create or replace trigger orders_audit after insert or update or delete on public.orders
  for each row execute function app.audit_row();

-- ----------------------------------------------------------------------------
-- A purge never removes a numbered order: it is detached first (and a draft that also belongs elsewhere is too)
-- ----------------------------------------------------------------------------
create or replace function app.orders_detach() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- the whole business is being deleted: its orders go with it
  if not app.org_exists(old.organization_id) then
    return old;
  end if;
  perform set_config('app.order_server', 'on', true);
  if tg_table_name = 'deals' then
    -- a numbered order stays with its contact or company; a draft of the deal goes with it
    update public.orders o set deal_id = null, former_deal_id = old.id
     where o.organization_id = old.organization_id and o.deal_id = old.id and o.status <> 'draft';
  elsif tg_table_name = 'contacts' then
    -- every order that also belongs elsewhere is detached; a draft that belongs to the contact alone goes with it
    update public.orders o set contact_id = null, former_contact_id = old.id
     where o.organization_id = old.organization_id and o.contact_id = old.id
       and (o.status <> 'draft' or o.deal_id is not null or o.company_id is not null);
  else
    update public.orders o set company_id = null, former_company_id = old.id
     where o.organization_id = old.organization_id and o.company_id = old.id
       and (o.status <> 'draft' or o.deal_id is not null or o.contact_id is not null);
  end if;
  -- nothing of the customer is left
  update public.orders o set customer_deleted_at = now()
   where o.organization_id = old.organization_id and o.deal_id is null and o.contact_id is null and o.company_id is null
     and o.customer_deleted_at is null
     and (o.former_deal_id = old.id or o.former_contact_id = old.id or o.former_company_id = old.id);
  perform set_config('app.order_server', '', true);
  return old;
end;
$$;
revoke all on function app.orders_detach() from public, anon, authenticated, service_role;

create or replace trigger deals_orders_detach before delete on public.deals
  for each row execute function app.orders_detach();
create or replace trigger contacts_orders_detach before delete on public.contacts
  for each row execute function app.orders_detach();
create or replace trigger companies_orders_detach before delete on public.companies
  for each row execute function app.orders_detach();

-- ----------------------------------------------------------------------------
-- The lines: server values, flags, the cap and the line total
-- ----------------------------------------------------------------------------
create or replace function app.order_lines_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_kind text;
  v_active boolean;
  v_archived timestamptz;
  v_billing text;
  v_unit text;
  v_totals jsonb;
  v_person boolean := auth.uid() is not null and coalesce(current_setting('app.order_server', true), '') <> 'on';
begin
  select * into v_order from public.orders o where o.organization_id = new.organization_id and o.id = new.order_id;
  -- outsider guard: RLS refuses (42501) a person who may not edit the order
  if v_person and (not found or not app.order_editable(v_order.organization_id, v_order.deal_id, v_order.contact_id, v_order.company_id)) then
    return new;
  end if;
  -- a numbered order's lines are as they were numbered (owner (2)), for every writer but the server's copy
  if v_person and v_order.status <> 'draft' then
    raise exception 'the lines of a numbered order cannot change' using errcode = 'P0001', hint = 'order:frozen';
  end if;

  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('order_lines:' || new.order_id::text, 0));
    if (select count(*) from public.order_lines l
         where l.organization_id = new.organization_id and l.order_id = new.order_id) >= 200 then
      raise exception 'at most 200 lines in an order' using errcode = 'P0001', hint = 'order_lines:max';
    end if;
    if v_person then
      -- a person's line is priced by hand or by its product; a price list's name comes only with a copy
      new.price_source := case when new.product_id is not null then 'product' else 'manual' end;
      new.price_list_name := null;
      if new.product_id is not null then
        if not app.org_has_feature(new.organization_id, 'products') then
          raise exception 'products are not in this plan' using errcode = 'P0001', hint = 'feature:products';
        end if;
        select p.vat_kind, p.is_active, p.archived_at, p.billing, u.name
          into v_kind, v_active, v_archived, v_billing, v_unit
          from public.products p
          left join public.product_units u on u.organization_id = p.organization_id and u.id = p.unit_id
         where p.organization_id = new.organization_id and p.id = new.product_id;
        if found then
          if not v_active or v_archived is not null then
            raise exception 'the product cannot be offered' using errcode = 'P0001', hint = 'order_lines:product';
          end if;
          new.vat_exempt := v_kind <> 'taxable';
          new.billing := v_billing;
          new.unit_name := v_unit;
        end if;
      else
        new.unit_name := null;
      end if;
    end if;
  else
    new.organization_id := old.organization_id;
    new.order_id := old.order_id;
    new.kind := old.kind;
    new.product_id := old.product_id;
    new.unit_name := old.unit_name;
    new.price_source := old.price_source;
    new.price_list_name := old.price_list_name;
    if old.product_id is not null then
      new.vat_exempt := old.vat_exempt;
      new.billing := old.billing;
    end if;
  end if;

  if new.kind = 'group' then
    new.vat_exempt := false;
    new.billing := 'one_time';
    new.total_agorot := 0;
    return new;
  end if;

  if v_person and (new.discount_bp is not null or new.discount_agorot is not null)
     and (tg_op = 'INSERT' or new.discount_bp is distinct from old.discount_bp or new.discount_agorot is distinct from old.discount_agorot)
     and not app.org_has_feature(new.organization_id, 'discounts') then
    raise exception 'discounts are not in this plan' using errcode = 'P0001', hint = 'feature:discounts';
  end if;

  v_totals := app.document_totals(
    jsonb_build_array(jsonb_build_object(
      'quantity', new.quantity,
      'unit_price_agorot', new.unit_price_agorot,
      'discount_bp', new.discount_bp,
      'discount_agorot', new.discount_agorot,
      'vat_exempt', new.vat_exempt)),
    0, coalesce(v_order.prices_include_vat, false));
  new.total_agorot := (v_totals #>> '{lines,0,total_agorot}')::bigint;
  return new;
end;
$$;
revoke all on function app.order_lines_check() from public, anon, authenticated, service_role;

create or replace trigger order_lines_check before insert or update on public.order_lines
  for each row execute function app.order_lines_check();
create or replace trigger order_lines_touch before insert or update on public.order_lines
  for each row execute function app.touch_row();
create or replace trigger order_lines_audit after insert or update or delete on public.order_lines
  for each row execute function app.audit_row();

-- a line's change works the draft's totals out again (the order's own trigger does the sums)
create or replace function app.order_lines_recompute() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org uuid := coalesce(new.organization_id, old.organization_id);
  v_order uuid := coalesce(new.order_id, old.order_id);
begin
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'position' - 'updated_at') = (to_jsonb(old) - 'position' - 'updated_at') then
    return null;
  end if;
  update public.orders o set updated_at = now()
   where o.organization_id = v_org and o.id = v_order and o.status = 'draft';
  return null;
end;
$$;
revoke all on function app.order_lines_recompute() from public, anon, authenticated, service_role;

create or replace trigger order_lines_recompute after insert or update or delete on public.order_lines
  for each row execute function app.order_lines_recompute();

-- ----------------------------------------------------------------------------
-- Numbering (ORD-03): the draft gets its number, day, customer name and amounts in one step
-- ----------------------------------------------------------------------------
create or replace function app.order_number(p_org uuid, p_order uuid) returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_contact record;
  v_company_name text;
  v_name text;
  v_number bigint;
  v_display text;
begin
  select * into v_order from public.orders o where o.organization_id = p_org and o.id = p_order for update;
  if v_order.contact_id is null and v_order.company_id is null then
    raise exception 'an order needs a contact or a company' using errcode = 'P0001', hint = 'order:customer';
  end if;
  if not exists (select 1 from public.order_lines l where l.organization_id = p_org and l.order_id = p_order and l.kind = 'item') then
    raise exception 'an order needs a line' using errcode = 'P0001', hint = 'order:empty';
  end if;
  if v_order.no_vat_reason is null and v_order.source <> 'quote'
     and app.org_document_vat_rate(p_org, (now() at time zone app.intake_zone((select o.timezone from public.organizations o where o.id = p_org)))::date) is null then
    raise exception 'the VAT status of the business is not set' using errcode = 'P0001', hint = 'order:vat_unknown';
  end if;
  -- the customer as the order names it (the rule of quote_send, CON-08 order)
  select c.full_name, c.billing_name, co.name as company_name, co.billing_name as company_billing_name into v_contact
    from public.contacts c left join public.companies co on co.organization_id = c.organization_id and co.id = c.company_id
   where c.organization_id = p_org and c.id = v_order.contact_id;
  select co.name into v_company_name from public.companies co where co.organization_id = p_org and co.id = v_order.company_id;
  v_name := coalesce(v_contact.billing_name, v_contact.company_billing_name, v_contact.company_name, v_company_name, v_contact.full_name);

  select n.o_number, n.o_display into v_number, v_display from app.next_document_number(p_org, 'order') n;
  perform set_config('app.order_server', 'on', true);
  update public.orders o
     set status = 'new', number = v_number, number_display = v_display, confirmed_at = now(),
         customer_name = coalesce(v_order.customer_name, v_name),
         order_date = (now() at time zone app.intake_zone((select og.timezone from public.organizations og where og.id = p_org)))::date
   where o.organization_id = p_org and o.id = p_order;
  perform set_config('app.order_server', '', true);
  return v_display;
end;
$$;
revoke all on function app.order_number(uuid, uuid) from public, anon, authenticated, service_role;

-- A person confirms their manual draft (owner (1)): whoever may edit it, the `orders` flag
create or replace function public.order_confirm(p_org uuid, p_order uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  select * into v_order from public.orders o where o.organization_id = p_org and o.id = p_order for update;
  if not found or not app.order_editable(p_org, v_order.deal_id, v_order.contact_id, v_order.company_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.org_has_feature(p_org, 'orders') then
    raise exception 'orders are not in this plan' using errcode = 'P0001', hint = 'feature:orders';
  end if;
  if v_order.status <> 'draft' then
    raise exception 'the order was already confirmed' using errcode = 'P0001', hint = 'order:frozen';
  end if;
  return jsonb_build_object('number', app.order_number(p_org, p_order));
end;
$$;
revoke all on function public.order_confirm(uuid, uuid) from public, anon;
grant execute on function public.order_confirm(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- An order from an accepted quote (owner (2), (3)): lines and prices as accepted, numbered at once
-- ----------------------------------------------------------------------------
create or replace function public.order_from_quote(p_org uuid, p_quote uuid) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
  v_new uuid;
  v_original uuid;
begin
  select * into v_quote from public.quotes q where q.organization_id = p_org and q.id = p_quote for share;
  if not found or not app.quote_editable(p_org, v_quote.deal_id, v_quote.contact_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.org_has_feature(p_org, 'orders') then
    raise exception 'orders are not in this plan' using errcode = 'P0001', hint = 'feature:orders';
  end if;
  if v_quote.status <> 'accepted' then
    raise exception 'an order is made from an accepted quote' using errcode = 'P0001', hint = 'order:quote_not_accepted';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('order_from_quote:' || p_quote::text, 0));
  if exists (select 1 from public.orders o where o.organization_id = p_org and o.quote_id = p_quote) then
    raise exception 'the quote already has an order' using errcode = 'P0001', hint = 'order:exists';
  end if;
  -- an accepted addendum is its own order, linked to the original quote's order (owner (3))
  if v_quote.addendum_of is not null then
    select o.id into v_original from public.orders o where o.organization_id = p_org and o.quote_id = v_quote.addendum_of;
  end if;

  perform set_config('app.order_server', 'on', true);
  insert into public.orders (organization_id, status, source, quote_id, original_order_id, deal_id, contact_id, company_id,
                             prices_include_vat, no_vat_reason, no_vat_note, discount_bp, discount_agorot, vat_rate_bp,
                             customer_name, currency)
  values (p_org, 'draft', 'quote', p_quote, v_original, v_quote.deal_id, v_quote.contact_id, v_quote.company_id,
          v_quote.prices_include_vat, v_quote.no_vat_reason, v_quote.no_vat_note, v_quote.discount_bp, v_quote.discount_agorot,
          v_quote.vat_rate_bp, v_quote.customer_name, v_quote.currency)
  returning id into v_new;
  -- the lines the customer accepted: items that count (not optional, or optional and selected) and the group headings
  insert into public.order_lines (organization_id, order_id, position, kind, product_id, name, description, unit_name, quantity,
                                  unit_price_agorot, discount_bp, discount_agorot, vat_exempt, billing, price_source,
                                  price_list_name, currency)
  select l.organization_id, v_new, l.position, l.kind, l.product_id, l.name, l.description, l.unit_name, l.quantity,
         l.unit_price_agorot, l.discount_bp, l.discount_agorot, l.vat_exempt, l.billing, l.price_source,
         l.price_list_name, l.currency
    from public.quote_lines l
   where l.organization_id = p_org and l.quote_id = p_quote
     and (l.kind = 'group' or not l.is_optional or l.optional_selected)
   order by l.position, l.id;
  perform set_config('app.order_server', '', true);
  perform app.order_number(p_org, v_new);
  return v_new;
end;
$$;
revoke all on function public.order_from_quote(uuid, uuid) from public, anon;
grant execute on function public.order_from_quote(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- An order from a won deal without an accepted quote (owner (4)): the deal's lines as they are, numbered at once
-- ----------------------------------------------------------------------------
create or replace function public.order_from_deal(p_org uuid, p_deal uuid) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_deal public.deals;
  v_new uuid;
  v_include boolean;
begin
  select * into v_deal from public.deals d where d.organization_id = p_org and d.id = p_deal for share;
  if not found or not app.quote_editable(p_org, p_deal, null) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.org_has_feature(p_org, 'orders') then
    raise exception 'orders are not in this plan' using errcode = 'P0001', hint = 'feature:orders';
  end if;
  if v_deal.status <> 'won' then
    raise exception 'an order is made from a won deal' using errcode = 'P0001', hint = 'order:deal_not_won';
  end if;
  -- a deal with an accepted quote is ordered through that quote
  if exists (select 1 from public.quotes q where q.organization_id = p_org and q.deal_id = p_deal and q.status = 'accepted') then
    raise exception 'the deal has an accepted quote' using errcode = 'P0001', hint = 'order:use_quote';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('order_from_deal:' || p_deal::text, 0));
  -- one order from the deal while it is not cancelled (a second click makes nothing)
  if exists (select 1 from public.orders o
              where o.organization_id = p_org and o.deal_id = p_deal and o.source = 'deal' and o.status <> 'cancelled') then
    raise exception 'the deal already has an order' using errcode = 'P0001', hint = 'order:exists';
  end if;
  if v_deal.contact_id is null and v_deal.company_id is null then
    raise exception 'an order needs a contact or a company' using errcode = 'P0001', hint = 'order:customer';
  end if;
  if not exists (select 1 from public.deal_lines l where l.organization_id = p_org and l.deal_id = p_deal) then
    raise exception 'an order needs a line' using errcode = 'P0001', hint = 'order:empty';
  end if;
  -- the deal's one VAT mode (DLI-01)
  select bool_or(l.price_includes_vat) into v_include from public.deal_lines l where l.organization_id = p_org and l.deal_id = p_deal;

  perform set_config('app.order_server', 'on', true);
  insert into public.orders (organization_id, status, source, deal_id, contact_id, company_id, prices_include_vat, currency)
  values (p_org, 'draft', 'deal', p_deal, v_deal.contact_id, v_deal.company_id, coalesce(v_include, false), 'ILS')
  returning id into v_new;
  insert into public.order_lines (organization_id, order_id, position, kind, product_id, name, quantity, unit_price_agorot,
                                  discount_bp, discount_agorot, vat_exempt, billing, price_source, price_list_name, currency,
                                  unit_name)
  select l.organization_id, v_new, l.position, 'item', l.product_id, left(l.description, 300), l.quantity, l.unit_price_agorot,
         l.discount_bp, l.discount_agorot, l.vat_exempt, coalesce(l.billing, 'one_time'), l.price_source, l.price_list_name,
         l.currency,
         (select u.name from public.products p join public.product_units u on u.organization_id = p.organization_id and u.id = p.unit_id
           where p.organization_id = l.organization_id and p.id = l.product_id)
    from public.deal_lines l
   where l.organization_id = p_org and l.deal_id = p_deal
   order by l.position, l.id;
  perform set_config('app.order_server', '', true);
  perform app.order_number(p_org, v_new);
  return v_new;
end;
$$;
revoke all on function public.order_from_deal(uuid, uuid) from public, anon;
grant execute on function public.order_from_deal(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Merges carry orders to the kept record (through the `merged` entry, as CON-05 does)
-- ----------------------------------------------------------------------------
create or replace function app.merge_orders() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_merged uuid;
begin
  if (new.metadata ->> 'merged_id') !~ '^[0-9a-fA-F-]{36}$' then
    return null;
  end if;
  v_merged := (new.metadata ->> 'merged_id')::uuid;
  perform set_config('app.order_server', 'on', true);
  if new.contact_id is not null and v_merged <> new.contact_id
     and exists (select 1 from public.contacts c where c.organization_id = new.organization_id and c.id = new.contact_id) then
    update public.orders o set contact_id = new.contact_id
     where o.organization_id = new.organization_id and o.contact_id = v_merged;
    update public.orders o set delivery_contact_id = new.contact_id
     where o.organization_id = new.organization_id and o.delivery_contact_id = v_merged;
  elsif new.company_id is not null and v_merged <> new.company_id
        and exists (select 1 from public.companies c where c.organization_id = new.organization_id and c.id = new.company_id) then
    update public.orders o set company_id = new.company_id
     where o.organization_id = new.organization_id and o.company_id = v_merged;
  end if;
  perform set_config('app.order_server', '', true);
  return null;
end;
$$;
revoke all on function app.merge_orders() from public, anon, authenticated, service_role;

create or replace trigger activities_merge_orders after insert on public.activities
  for each row
  when (new.type = 'system' and (new.contact_id is not null or new.company_id is not null) and new.metadata ? 'merged_id')
  execute function app.merge_orders();

-- ----------------------------------------------------------------------------
-- Privacy erasure (the body of 020520, its latest, plus the orders block)
-- ----------------------------------------------------------------------------
create or replace function app.audit_erase_core(p_org uuid, p_type text, p_id uuid, p_actor uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  v_col text := case p_type when 'leads' then 'lead_id' when 'contacts' then 'contact_id'
                            when 'companies' then 'company_id' when 'deals' then 'deal_id' end;
  v_exists boolean;
  v_row jsonb;
  v_child record;
  v_children text[] := '{}';
  v_count integer;
  v_more integer;
begin
  if v_col is null then
    raise exception 'unknown record type' using errcode = '22023';
  end if;
  execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)', p_type)
    into v_exists using p_org, p_id;
  if v_exists then
    raise exception 'delete the record permanently first' using errcode = 'P0001', hint = 'erase:exists';
  end if;

  -- the deleted row, for the form submissions below (before it is erased)
  select a.changes into v_row from public.audit_log a
   where a.organization_id = p_org and a.entity_type = p_type and a.entity_id = p_id and a.action = 'delete'
   order by a.id desc limit 1;

  -- tasks, files, notes and deal lines (DLI-01) that were linked to it and no longer exist: by the
  -- ids in their entries, and for notes by every record they were ever linked to
  for v_child in
    select distinct a.entity_type, a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type in ('tasks', 'files', 'activities', 'deal_lines', 'quotes', 'orders') and a.entity_id is not null
       and (a.changes ->> v_col = p_id::text or a.changes -> v_col ->> 'old' = p_id::text or a.changes -> v_col ->> 'new' = p_id::text)
    union
    select 'activities', l.activity_id from app.activity_audit_links l
     where l.organization_id = p_org and l.record_id = p_id
  loop
    execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)', v_child.entity_type)
      into v_exists using p_org, v_child.entity_id;
    if not v_exists then
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end if;
  end loop;

  -- QUO-01: the lines of those quotes (their entries carry quote_id, not the record's id); GAP-09: and their payment schedule
  for v_child in
    select distinct a.entity_type, a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type in ('quote_lines', 'quote_payment_steps') and a.entity_id is not null
       and coalesce(a.changes ->> 'quote_id', a.changes -> 'quote_id' ->> 'old') = any (
             select substr(c, length('quotes:') + 1) from unnest(v_children) c where c like 'quotes:%')
  loop
    execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)', v_child.entity_type)
      into v_exists using p_org, v_child.entity_id;
    if not v_exists then
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end if;
  end loop;

  -- QUO-07: a sent quote that was detached from the record keeps its number, date and amounts; its
  -- personal details are emptied, and its own entries are erased below with the rest. A draft that
  -- only named the record (a deal's quote naming a purged contact) is the deal's and is left alone.
  if p_type in ('contacts', 'deals') then
    for v_child in
      update public.quotes q
         set customer_name = null, customer_contact_name = null, notes = null, title = 'הצעת מחיר',
             -- QUO-11: the reason staff wrote when cancelling an accepted quote may name the customer
             cancel_reason = null
       where q.organization_id = p_org and q.status <> 'draft'
         and ((p_type = 'contacts' and q.former_contact_id = p_id) or (p_type = 'deals' and q.former_deal_id = p_id))
      returning 'quotes'::text as entity_type, q.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    -- owner, 18 October 2026 (QUO-07): the free text of those quotes' lines goes too: quantity, price and amounts stay;
    -- a free line and a group heading get a neutral name; every description is emptied. Owner, 19 October 2026: a
    -- product line's name that was edited by hand goes too. "Edited by hand" in the data = the stored name differs
    -- (trimmed) from the product's current catalog name; such a line takes the catalog name (not personal), and a
    -- product that is gone leaves the neutral name. A product line still named as in the catalog keeps it. Payment
    -- steps, milestones and terms stay (owner). These lines' entries (the old text included) are erased below.
    for v_child in
      update public.quote_lines l
         set description = null,
             name = case
                      when l.kind = 'group' then 'קבוצה'
                      when l.product_id is null then 'שורה'
                      else coalesce((select p.name from public.products p
                                      where p.organization_id = l.organization_id and p.id = l.product_id), 'שורה')
                    end
       where l.organization_id = p_org
         and l.quote_id = any (select substr(c, length('quotes:') + 1)::uuid from unnest(v_children) c where c like 'quotes:%')
         and exists (select 1 from public.quotes q where q.organization_id = p_org and q.id = l.quote_id and q.status <> 'draft')
      returning 'quote_lines'::text as entity_type, l.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    -- QUO-11: the cancel entry of those quotes on the timeline loses its " · סיבה: …" part (the rest is number and author);
    -- the entries' audit history (the old body included) is erased below with the rest
    for v_child in
      update public.activities ac
         set body = regexp_replace(ac.body, ' · סיבה: .*$', '')
       where ac.organization_id = p_org and ac.metadata ->> 'kind' = 'quote_cancelled'
         and ac.metadata ->> 'quote_id' = any (select substr(c, length('quotes:') + 1) from unnest(v_children) c where c like 'quotes:%')
         and ac.body like '% · סיבה: %'
      returning 'activities'::text as entity_type, ac.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    -- QUO-09 (owner, 18 October 2026): the customer's decision on those quotes keeps what, when and the fingerprint of the
    -- version; the signer's name, ID, signature, IP, browser and reason go (the table is not audited)
    update public.quote_decisions d
       set signer_name = null, signer_id_number = null, signature_image = null, ip = null, user_agent = null,
           decline_reason = null, erased_at = coalesce(d.erased_at, now())
     where d.organization_id = p_org
       and d.quote_id = any (select substr(c, length('quotes:') + 1)::uuid from unnest(v_children) c where c like 'quotes:%');
  end if;

  -- ORD-01: an order that was detached from the record keeps its number, date, lines' amounts and totals; the customer's
  -- name, the shipping address and the notes go, and its lines' free text goes as for quotes (a product line takes the
  -- catalog name, a free line and a heading a neutral one, every description is emptied). A draft only loses the
  -- shipping address and the name it may have copied from the record. Its entries are erased below with the rest.
  if p_type in ('contacts', 'companies', 'deals') then
    perform set_config('app.order_server', 'on', true);
    for v_child in
      update public.orders o
         set customer_name = case when o.status <> 'draft' then null else o.customer_name end,
             shipping_address = null,
             notes = case when o.status <> 'draft' then null else o.notes end
       where o.organization_id = p_org
         and ((p_type = 'contacts' and o.former_contact_id = p_id) or (p_type = 'deals' and o.former_deal_id = p_id)
              or (p_type = 'companies' and o.former_company_id = p_id))
      returning 'orders'::text as entity_type, o.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    for v_child in
      update public.order_lines l
         set description = null,
             name = case
                      when l.kind = 'group' then 'קבוצה'
                      when l.product_id is null then 'שורה'
                      else coalesce((select p.name from public.products p
                                      where p.organization_id = l.organization_id and p.id = l.product_id), 'שורה')
                    end
       where l.organization_id = p_org
         and l.order_id = any (select substr(c, length('orders:') + 1)::uuid from unnest(v_children) c where c like 'orders:%')
         and exists (select 1 from public.orders o where o.organization_id = p_org and o.id = l.order_id and o.status <> 'draft')
      returning 'order_lines'::text as entity_type, l.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    perform set_config('app.order_server', '', true);
  end if;
  -- the lines of those orders (kept or gone) that are gone themselves: their entries carry order_id
  for v_child in
    select distinct a.entity_type, a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type = 'order_lines' and a.entity_id is not null
       and coalesce(a.changes ->> 'order_id', a.changes -> 'order_id' ->> 'old') = any (
             select substr(c, length('orders:') + 1) from unnest(v_children) c where c like 'orders:%')
  loop
    if not exists (select 1 from public.order_lines l where l.organization_id = p_org and l.id = v_child.entity_id) then
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end if;
  end loop;

  update public.audit_log a set changes = '{"erased": true}'::jsonb
   where a.organization_id = p_org
     and ((a.entity_type = p_type and a.entity_id = p_id) or (a.entity_type || ':' || a.entity_id) = any (v_children))
     and a.action <> 'erase'
     and a.changes is distinct from '{"erased": true}'::jsonb;
  get diagnostics v_count = row_count;

  -- the copy kept by a merge, on the record it was merged into
  update public.activities ac
     set metadata = ac.metadata - 'merged', body = 'מוזג עם רשומה כפולה (הפרטים נמחקו)'
   where ac.organization_id = p_org and ac.metadata ->> 'merged_id' = p_id::text and ac.metadata ? 'merged';
  get diagnostics v_more = row_count;
  v_count := v_count + v_more;

  v_count := v_count + app.erase_submissions(p_org, v_row);

  -- CNS-02: its consent history keeps only the hash, the state and the time
  if p_type in ('leads', 'contacts') then
    update public.consents c set method = null, wording = null, recorded_by = null, lift_note = null
     where c.organization_id = p_org
       and c.subject_type = case p_type when 'leads' then 'lead' else 'contact' end
       and c.subject_id = p_id
       and (c.method is not null or c.wording is not null or c.recorded_by is not null or c.lift_note is not null);
    get diagnostics v_more = row_count;
    v_count := v_count + v_more;
    -- an entry still waiting for its hash (written without the key): with the key there,
    -- it gets its hash first, so the opt-out keeps working; then the stored address is
    -- blanked. Without the key it stays unmatchable and keeps app.consent_suppressed() at
    -- "cannot check" for its channel (fail closed).
    if app.consent_key_present() then
      update public.consents c set address_hash = app.consent_pending_hash(c.id)
       where c.organization_id = p_org
         and c.subject_type = case p_type when 'leads' then 'lead' else 'contact' end
         and c.subject_id = p_id and c.address_hash is null and c.hash_version = 1
         and app.consent_pending_hash(c.id) is not null;
    end if;
    update app.consent_pending_address p set value = null
      from public.consents c
     where c.id = p.consent_id and c.organization_id = p_org
       and c.subject_type = case p_type when 'leads' then 'lead' else 'contact' end
       and c.subject_id = p_id and p.value is not null;
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, p_actor, 'erase', p_type, p_id, jsonb_build_object('entries', v_count));
  return v_count;
end;
$$;
revoke all on function app.audit_erase_core(uuid, text, uuid, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Sample data: an order keeps the sample record (the body of 020315, its latest)
-- ----------------------------------------------------------------------------
create or replace function app.sample_untouched(p_org uuid, p_type text, p_id uuid, p_snapshot jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  v_col text := p_type || '_id';
  v_found boolean;
begin
  if app.sample_row(p_org, p_type, p_id) is distinct from p_snapshot then
    return false;
  end if;
  if p_type = 'task' then
    -- TASK-06: a sample task a person gave steps to is real work
    return not exists (select 1 from public.task_checklist_items i where i.organization_id = p_org and i.task_id = p_id);
  end if;
  -- notes, files and meetings are never sample data
  execute format(
    'select exists (select 1 from public.activities where organization_id = $1 and %1$I = $2)
         or exists (select 1 from public.files where organization_id = $1 and %1$I = $2)
         or exists (select 1 from public.meetings where organization_id = $1 and %1$I = $2)', v_col)
    into v_found using p_org, p_id;
  if v_found then
    return false;
  end if;
  -- a task that is not an unchanged sample task, or one a person gave steps to (TASK-06; removing the record would
  -- take such a task with it)
  execute format(
    'select exists (select 1 from public.tasks t where t.organization_id = $1 and t.%1$I = $2
                     and (not app.sample_pristine($1, ''task'', t.id)
                          or exists (select 1 from public.task_checklist_items i
                                      where i.organization_id = t.organization_id and i.task_id = t.id)))', v_col)
    into v_found using p_org, p_id;
  if v_found then
    return false;
  end if;
  if p_type = 'lead' then
    return not exists (select 1 from public.form_submissions f where f.organization_id = p_org and f.lead_id = p_id)
       -- CNS-01: sample data records no consent; one recorded is real work
       and not exists (select 1 from public.consents cn where cn.organization_id = p_org and cn.lead_id = p_id)
       -- CON-06: a referral by the lead
       and not exists (select 1 from public.contact_relations cr where cr.organization_id = p_org and cr.lead_id = p_id)
       -- SEG-01: put in a list by a person
       and not exists (select 1 from public.segment_members sm where sm.organization_id = p_org and sm.lead_id = p_id);
  elsif p_type = 'contact' then
    return not exists (select 1 from public.deal_contacts dc where dc.organization_id = p_org and dc.contact_id = p_id)
       and not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_contact_id = p_id)
       and not exists (select 1 from public.deals d where d.organization_id = p_org and d.contact_id = p_id
                         and not app.sample_untouched_id(p_org, 'deal', d.id))
       -- CON-01: sample data adds no further phones or emails; one added is real work
       and not exists (select 1 from public.contact_channels ch where ch.organization_id = p_org and ch.contact_id = p_id)
       -- CNS-01: a consent recorded on it
       and not exists (select 1 from public.consents cn where cn.organization_id = p_org and cn.contact_id = p_id)
       -- CON-05: a further company, or a role at the primary one
       and not exists (select 1 from public.contact_companies cc where cc.organization_id = p_org and cc.contact_id = p_id
                         and (not cc.is_primary or cc.title is not null))
       -- CON-06: sample data makes no relations; one made is real work
       and not exists (select 1 from public.contact_relations cr where cr.organization_id = p_org and p_id in (cr.contact_id, cr.related_contact_id))
       -- QUO-01: sample data makes no quotes; one made is real work
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.contact_id = p_id)
       -- ORD-01: sample data makes no orders; one made is real work
       and not exists (select 1 from public.orders od where od.organization_id = p_org and p_id in (od.contact_id, od.delivery_contact_id))
       -- SEG-01: put in a list by a person
       and not exists (select 1 from public.segment_members sm where sm.organization_id = p_org and sm.contact_id = p_id);
  elsif p_type = 'company' then
    return not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_company_id = p_id)
       and not exists (select 1 from public.companies c where c.organization_id = p_org and c.parent_company_id = p_id)
       and not exists (select 1 from public.contacts c where c.organization_id = p_org and c.company_id = p_id
                         and not app.sample_untouched_id(p_org, 'contact', c.id))
       and not exists (select 1 from public.deals d where d.organization_id = p_org and d.company_id = p_id
                         and not app.sample_untouched_id(p_org, 'deal', d.id))
       -- CON-05: someone linked to it as a further company, or given a role there
       and not exists (select 1 from public.contact_companies cc where cc.organization_id = p_org and cc.company_id = p_id
                         and (not cc.is_primary or cc.title is not null))
       -- QUO-01
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.company_id = p_id)
       -- ORD-01
       and not exists (select 1 from public.orders od where od.organization_id = p_org and od.company_id = p_id);
  else -- deal
    return not exists (select 1 from public.deal_contacts dc where dc.organization_id = p_org and dc.deal_id = p_id)
       and not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_deal_id = p_id)
       -- DLI-01: sample data adds no product lines; one added is real work
       and not exists (select 1 from public.deal_lines dl where dl.organization_id = p_org and dl.deal_id = p_id)
       -- QUO-01
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.deal_id = p_id)
       -- ORD-01
       and not exists (select 1 from public.orders od where od.organization_id = p_org and od.deal_id = p_id);
  end if;
end;
$$;

revoke all on function app.sample_untouched(uuid, text, uuid, jsonb) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Undo of one's own import: an order is work (the body of 020450, its latest)
-- ----------------------------------------------------------------------------
create or replace function app.import_record_worked(p_org uuid, p_type text, p_id uuid, p_since timestamptz, p_job uuid)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_col text := case p_type when 'lead' then 'lead_id' when 'contact' then 'contact_id'
                            when 'company' then 'company_id' when 'deal' then 'deal_id' end;
  v_found boolean;
begin
  -- RVW-36: an imported task is worked on when a checklist step was added after the import or any step is done
  if p_type = 'task' then
    return exists (select 1 from public.task_checklist_items x
                    where x.organization_id = p_org and x.task_id = p_id
                      and (x.created_at > p_since or x.done_at is not null));
  end if;
  -- no other records are linked to an imported task; its own row and its steps are the whole story
  if v_col is null then
    return false;
  end if;
  execute format(
    'select exists (select 1 from public.activities x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.tasks x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.meetings x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.files x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.record_followers x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)',
    v_col)
    into v_found using p_org, p_id, p_since;
  if v_found then
    return true;
  end if;
  if p_type = 'lead' then
    return exists (select 1 from public.consents x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since)
        -- CON-06: a referral by the lead, made after the import
        or exists (select 1 from public.contact_relations x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since)
        -- SEG-01: put in a static segment after the import
        or exists (select 1 from public.segment_members x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since);
  elsif p_type = 'contact' then
    return exists (select 1 from public.quotes x where x.organization_id = p_org and x.contact_id = p_id)
        -- ORD-01: an order is always made after the import
        or exists (select 1 from public.orders x where x.organization_id = p_org and p_id in (x.contact_id, x.delivery_contact_id))
        or exists (select 1 from public.consents x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.contact_channels x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        -- put on a deal later, or a deal from outside this import points at it
        or exists (select 1 from public.deal_contacts x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.contact_id = p_id
                     and x.import_job_id is distinct from p_job)
        -- CON-05: a company linked, or a role changed, after the import
        or exists (select 1 from public.contact_companies x where x.organization_id = p_org and x.contact_id = p_id
                     and greatest(x.created_at, x.updated_at) > p_since)
        -- CON-06: a relation made after the import, on either side
        or exists (select 1 from public.contact_relations x where x.organization_id = p_org
                     and p_id in (x.contact_id, x.related_contact_id) and x.created_at > p_since)
        -- SEG-01: put in a static segment after the import
        or exists (select 1 from public.segment_members x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since);
  elsif p_type = 'company' then
    -- a contact, deal or company from outside this import points at it (made later, or moved onto it later)
    return exists (select 1 from public.quotes x where x.organization_id = p_org and x.company_id = p_id)
        or exists (select 1 from public.orders x where x.organization_id = p_org and x.company_id = p_id)
        or exists (select 1 from public.contacts x where x.organization_id = p_org and x.company_id = p_id
                     and x.import_job_id is distinct from p_job)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.company_id = p_id
                     and x.import_job_id is distinct from p_job)
        or exists (select 1 from public.companies x where x.organization_id = p_org and x.parent_company_id = p_id
                     and x.import_job_id is distinct from p_job)
        -- CON-05: someone linked to it, or given a role there, after the import; links of this import's own contacts
        -- (written in a later chunk of it) are not work
        or exists (select 1 from public.contact_companies x where x.organization_id = p_org and x.company_id = p_id
                     and greatest(x.created_at, x.updated_at) > p_since
                     and not exists (select 1 from public.contacts k
                                      where k.organization_id = p_org and k.id = x.contact_id and k.import_job_id = p_job));
  elsif p_type = 'deal' then
    return exists (select 1 from public.quotes x where x.organization_id = p_org and x.deal_id = p_id)
        or exists (select 1 from public.orders x where x.organization_id = p_org and x.deal_id = p_id)
        or exists (select 1 from public.deal_lines x where x.organization_id = p_org and x.deal_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.deal_contacts x where x.organization_id = p_org and x.deal_id = p_id and x.created_at > p_since)
        -- a follow-up deal from outside this import points at it (DEAL-11)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.previous_deal_id = p_id
                     and x.import_job_id is distinct from p_job);
  end if;
  return false;
end;
$$;
revoke all on function app.import_record_worked(uuid, text, uuid, timestamptz, uuid) from public, anon, authenticated;
