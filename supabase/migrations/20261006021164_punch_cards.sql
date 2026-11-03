-- =============================================================================
-- PKG-01: punch cards (כרטיסייה): a product of kind 'punch_card' and a customer's card
-- =============================================================================
-- "מוצר מסוג 'כרטיסייה': מספר כניסות, תוקף, והשירותים שהיא חלה עליהם. נמכרת כמו כל מוצר" (SPEC-ADDITIONS, wave 3), with
-- the defaults of 22.9: a card opens when a payment is recorded for it, or when an owner/admin activates it by hand; after
-- its validity the balance is shown and cannot be used; a refund for unused entries is a manual action of an authorized
-- person (PAY-08 records the money; here an owner/admin cancels the card with a reason); a transfer to another customer is
-- for owners/admins only. Plan key `punch_cards` (owner (66) ג, migration punch_cards_plan: basic and up).
--
-- * public.products: kind takes 'punch_card'. Its settings are four nullable columns, written on the product's page by
--   whoever edits the catalog (column grants): punch_entries (1..1000), punch_validity_count + punch_validity_unit
--   (days|months, both or neither; none = no expiry) and punch_meeting_type_ids (1..50 CAL-08 meeting types of the same
--   business: a held meeting of one of them uses an entry, PKG-02). The services are meeting types, not products: a
--   meeting carries a meeting type (CAL-08), never a product, so the type is what PKG-02 can match. The list is read live
--   from the product, so adding a type later counts for cards already sold. Constraint products_punch_shape keeps the four
--   empty on every other kind. Definer trigger products_punch_card (outsider guard first: app.can_edit_catalog): a person
--   needs the key to make a punch card product or change its settings (hint feature:punch_cards); the meeting types are
--   checked when the list changes (hint punch_card:meeting_types); a product with a live card (not cancelled) never stops
--   being a punch card (hint punch_card:kind_in_use); turning a product into another kind empties the settings.
--   The card is sold like any product: it is a product line in a quote, an order, a deal or a quick sale (GAP-08).
-- * public.punch_cards: one card of one contact: a snapshot of the product's name, entries and validity taken when the card
--   is opened (a later change of the product never changes a card sold), status pending|active|cancelled, the payment that
--   opened it, when it was activated and by whom, expires_on (the last day it may be used, by the business's calendar:
--   activation day + the validity, app.punch_card_expires_on), cancel (reason required), transfer marks. No client write
--   grant: every write goes through the definer functions below, which judge rights first.
--   Read by whoever reads the contact (the rule of activities_select). Composite FKs: contact cascade (a purged contact
--   takes its cards and their entries, so erasure has nothing left), product with no on delete action (a product a card
--   uses is archived, never removed: PRD-02), payment set null of the column. Audited (owner (87) ב).
--   Definer trigger punch_cards_feature (outsider guard first): opening, activating or transferring a card needs the key
--   (hint feature:punch_cards); cancelling never does (the safe side).
-- * Functions (definer, authenticated; each checks rights first and answers 42501 to someone who may not act):
--   punch_card_open(org, contact, product, payment, activate): whoever records payments (app.can_record_payments) in a
--     writable business, on a live contact they read, an offerable punch card product with its entries set. With a recorded
--     or confirmed payment of the same contact the card opens active ("נפתחת כשנרשם תשלום"); with p_activate an owner/admin
--     activates it by hand; otherwise it waits as pending.
--   punch_card_activate(org, card, payment): a pending card, with a payment of its contact (payment recorders) or by hand
--     (owners/admins, payment null).
--   punch_card_cancel(org, card, reason): owners/admins; a refund for unused entries is recorded on the payment (PAY-08).
--   punch_card_transfer(org, card, contact): owners/admins; a card not cancelled, to another live contact.
-- * Merge: the duplicate's cards go to the kept contact on the `merged` entry (app.merge_punch_cards, the pattern of
--   app.merge_messages), before the duplicate is deleted.
-- Owner's answers of 3 November 2026: (85) ב a card also opens by itself from a counted payment on an order or quote
-- with a punch card line (app.punch_cards_auto_open, below); (87) ב the cards are in the action log (audit_row; the privacy
-- erasure in migration punch_card_erase; former_contact_ids keeps every earlier holder). Review finding 1: a payment opens
-- at most what it paid for (price_agorot, app.punch_card_payment_room, hint punch_card:payment_used); a payment that stops
-- counting stamps payment_void_at on its cards (never cancels them).
-- Owner (109) ב: an automatic opening that fails inside the payment's, allocation's or acceptance's transaction is kept in
-- app.punch_card_retries (ids and codes only) and opened later by pg_cron `crm-punch-card-retry`
-- (app.retry_punch_card_openings, every 5 minutes: fair per business, 20 a business and 100 a run, never waiting for a lock, 5 / 15 minutes then hourly,
-- given up after 3 days with one notice). The failure notice still goes once per event.
-- Every statement is safe to run twice. No drop statement, no delete.

-- ----------------------------------------------------------------------------
-- Products: the punch card kind and its settings
-- ----------------------------------------------------------------------------
alter table public.products add column if not exists punch_entries integer
  check (punch_entries is null or punch_entries between 1 and 1000);
alter table public.products add column if not exists punch_validity_count integer
  check (punch_validity_count is null or punch_validity_count between 1 and 3660);
alter table public.products add column if not exists punch_validity_unit text
  check (punch_validity_unit is null or punch_validity_unit in ('days', 'months'));
alter table public.products add column if not exists punch_meeting_type_ids uuid[]
  check (punch_meeting_type_ids is null or cardinality(punch_meeting_type_ids) between 1 and 50);

alter table public.products drop constraint if exists products_kind_check;
alter table public.products add constraint products_kind_check
  check (kind in ('product', 'service', 'subscription', 'bundle', 'punch_card'));

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'products_punch_shape' and conrelid = 'public.products'::regclass) then
    alter table public.products add constraint products_punch_shape check (
      (kind = 'punch_card'
       or (punch_entries is null and punch_validity_count is null and punch_validity_unit is null and punch_meeting_type_ids is null))
      and ((punch_validity_count is null) = (punch_validity_unit is null))
    );
  end if;
end;
$$;

grant insert (punch_entries, punch_validity_count, punch_validity_unit, punch_meeting_type_ids) on public.products to authenticated;
grant update (punch_entries, punch_validity_count, punch_validity_unit, punch_meeting_type_ids) on public.products to authenticated;

-- ----------------------------------------------------------------------------
-- The customer's card
-- ----------------------------------------------------------------------------
create table if not exists public.punch_cards (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  contact_id          uuid not null,
  product_id          uuid not null,
  name                text not null check (char_length(name) between 1 and 200),
  entries_total       integer not null check (entries_total between 1 and 1000),
  validity_count      integer check (validity_count is null or validity_count between 1 and 3660),
  validity_unit       text check (validity_unit is null or validity_unit in ('days', 'months')),
  status              text not null default 'pending' check (status in ('pending', 'active', 'cancelled')),
  payment_id          uuid,
  activated_at        timestamptz,
  activated_by        uuid references auth.users (id) on delete set null,
  activated_manually  boolean not null default false,
  expires_on          date,
  cancelled_at        timestamptz,
  cancelled_by        uuid references auth.users (id) on delete set null,
  cancel_reason       text check (cancel_reason is null or char_length(cancel_reason) between 1 and 500),
  transferred_at      timestamptz,
  transferred_by      uuid references auth.users (id) on delete set null,
  -- server only: what the card was sold for (the product's price, or the order/quote line's unit price), counted against
  -- its payment (review finding 1); the line and unit an automatic opening came from (owner (85) ב); when its payment
  -- stopped counting; every contact that held it before (owner (87) ב: erasure of a former holder reaches the card)
  price_agorot        bigint not null default 0 check (price_agorot between 0 and 1000000000000),
  currency            text not null default 'ILS' check (currency = 'ILS'),
  order_line_id       uuid,
  quote_line_id       uuid,
  unit_no             integer check (unit_no is null or unit_no between 1 and 20),
  payment_void_at     timestamptz,
  former_contact_ids  uuid[] not null default '{}',
  -- server only (second review, finding 5): every earlier holder and until when they held it, [{contact, until}], oldest
  -- first; the first holder's time starts at created_at
  holder_history      jsonb not null default '[]'::jsonb check (jsonb_typeof(holder_history) = 'array'),
  -- server only (second review, finding 6): the quick-sale deal line a card was opened from (one card per line and unit)
  deal_line_id        uuid,
  created_by          uuid default auth.uid() references auth.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (organization_id, id),
  constraint punch_cards_contact_fk foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete cascade,
  -- no action: a product a card uses is archived, never removed (PRD-02)
  constraint punch_cards_product_fk foreign key (organization_id, product_id)
    references public.products (organization_id, id),
  constraint punch_cards_payment_fk foreign key (organization_id, payment_id)
    references public.payments (organization_id, id) on delete set null (payment_id),
  constraint punch_cards_order_line_fk foreign key (organization_id, order_line_id)
    references public.order_lines (organization_id, id) on delete set null (order_line_id),
  constraint punch_cards_quote_line_fk foreign key (organization_id, quote_line_id)
    references public.quote_lines (organization_id, id) on delete set null (quote_line_id),
  constraint punch_cards_deal_line_fk foreign key (organization_id, deal_line_id)
    references public.deal_lines (organization_id, id) on delete set null (deal_line_id),
  constraint punch_cards_line_shape check (num_nonnulls(order_line_id, quote_line_id, deal_line_id) <= 1),
  constraint punch_cards_validity_pair check ((validity_count is null) = (validity_unit is null)),
  constraint punch_cards_state_shape check (
    (status <> 'active' or activated_at is not null)
    and (status <> 'pending' or (activated_at is null and expires_on is null))
    and ((status = 'cancelled') = (cancelled_at is not null and cancel_reason is not null))
    and (expires_on is null or activated_at is not null)
  )
);
create index if not exists punch_cards_contact_idx on public.punch_cards (organization_id, contact_id);
create index if not exists punch_cards_product_idx on public.punch_cards (organization_id, product_id);
create index if not exists punch_cards_payment_idx on public.punch_cards (organization_id, payment_id);
create index if not exists punch_cards_order_line_idx on public.punch_cards (organization_id, order_line_id);
create index if not exists punch_cards_quote_line_idx on public.punch_cards (organization_id, quote_line_id);
create index if not exists punch_cards_deal_line_idx on public.punch_cards (organization_id, deal_line_id);
create unique index if not exists punch_cards_deal_line_unit_idx on public.punch_cards (organization_id, deal_line_id, unit_no)
  where deal_line_id is not null;
-- owner (85) ב: a line's unit opens one card, never twice
create unique index if not exists punch_cards_order_line_unit_idx on public.punch_cards (organization_id, order_line_id, unit_no)
  where order_line_id is not null;
create unique index if not exists punch_cards_quote_line_unit_idx on public.punch_cards (organization_id, quote_line_id, unit_no)
  where quote_line_id is not null;

alter table public.punch_cards enable row level security;
revoke all on public.punch_cards from anon, authenticated;
grant select on public.punch_cards to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'punch_cards' and policyname = 'punch_cards_select') then
    -- whoever reads the contact reads its cards (the rule of activities_select)
    create policy punch_cards_select on public.punch_cards for select to authenticated
      using (app.is_member(organization_id)
             and app.can_read_activity_subject(null, contact_id, null, null));
  end if;
end;
$$;

create or replace trigger punch_cards_touch before update on public.punch_cards
  for each row execute function app.touch_row();
-- owner (87) ב: in the action log too (privacy erasure: migration punch_card_erase)
create or replace trigger punch_cards_audit after insert or update or delete on public.punch_cards
  for each row execute function app.audit_row();

-- Who sells and opens a card: whoever records payments, in a writable business
create or replace function app.punch_card_seller(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app.can_record_payments(p_org) and app.org_writable(p_org)
$$;
revoke all on function app.punch_card_seller(uuid) from public, anon, authenticated;

-- The last day a card may be used: the activation day (business calendar) plus the validity; null = no expiry
create or replace function app.punch_card_expires_on(p_day date, p_count integer, p_unit text) returns date
language sql immutable
set search_path = ''
as $$
  select case
    when p_day is null or p_count is null then null
    when p_unit = 'days' then p_day + p_count
    when p_unit = 'months' then (p_day + make_interval(months => p_count))::date
  end
$$;
revoke all on function app.punch_card_expires_on(date, integer, text) from public, anon, authenticated;

-- Today in the business's zone
create or replace function app.punch_card_today(p_org uuid) returns date
language sql stable security definer
set search_path = ''
as $$
  select (now() at time zone app.intake_zone((select o.timezone from public.organizations o where o.id = p_org)))::date
$$;
revoke all on function app.punch_card_today(uuid) from public, anon, authenticated;

-- A live contact of the business that the caller reads (definer callers bypass RLS, so the rule is asked here)
create or replace function app.punch_card_contact_ok(p_org uuid, p_contact uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.contacts c
                  where c.organization_id = p_org and c.id = p_contact and c.deleted_at is null
                    and app.can_read_record(p_org, c.owner_id, c.team_id))
$$;
revoke all on function app.punch_card_contact_ok(uuid, uuid) from public, anon, authenticated;

-- A payment that may open a card of this contact: recorded or confirmed, on the same contact
create or replace function app.punch_card_payment_ok(p_org uuid, p_contact uuid, p_payment uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.payments pm
                  where pm.organization_id = p_org and pm.id = p_payment and pm.contact_id = p_contact
                    and pm.status in ('recorded', 'confirmed'))
$$;
revoke all on function app.punch_card_payment_ok(uuid, uuid, uuid) from public, anon, authenticated;

-- Review finding 1: a payment opens at most what it paid for. The cards linked to it that are not cancelled, with the new
-- one, may not be sold for more than the payment counts (public.payment_counted: its amount less active refunds). The
-- caller holds the payment's row lock (FOR UPDATE), so two openings on one payment wait for each other.
create or replace function app.punch_card_payment_room(p_org uuid, p_payment uuid, p_price bigint) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((select public.payment_counted(pm) from public.payments pm where pm.organization_id = p_org and pm.id = p_payment), 0)
         >= coalesce(p_price, 0)
            + coalesce((select sum(c.price_agorot) from public.punch_cards c
                         where c.organization_id = p_org and c.payment_id = p_payment and c.status <> 'cancelled'), 0)
$$;
revoke all on function app.punch_card_payment_room(uuid, uuid, bigint) from public, anon, authenticated;

-- Owner (93) ב: a card's price is compared with the payment WITH VAT. An amount typed before VAT gets VAT at the rate given
-- (half up); an amount that includes VAT, an exempt line or product, or no rate (0 or unknown) is taken as it is.
create or replace function app.punch_with_vat(p_amount numeric, p_includes boolean, p_exempt boolean, p_rate_bp integer) returns bigint
language sql immutable
set search_path = ''
as $$
  select case when p_amount is null then null
              when coalesce(p_includes, false) or coalesce(p_exempt, false) or coalesce(p_rate_bp, 0) <= 0 then round(p_amount)::bigint
              else round(p_amount * (10000 + p_rate_bp) / 10000)::bigint end
$$;
revoke all on function app.punch_with_vat(numeric, boolean, boolean, integer) from public, anon, authenticated, service_role;

-- A product's price with VAT at the business's rate for today (a card opened by hand from the catalogue)
create or replace function app.punch_product_price(p_org uuid, p_product uuid) returns bigint
language sql stable security definer
set search_path = ''
as $$
  select app.punch_with_vat(p.price_agorot, p.price_includes_vat, p.vat_kind <> 'taxable',
                            app.org_document_vat_rate(p_org, app.punch_card_today(p_org)))
    from public.products p where p.organization_id = p_org and p.id = p_product
$$;
revoke all on function app.punch_product_price(uuid, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The product trigger
-- ----------------------------------------------------------------------------
create or replace function app.products_punch_card() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  -- outsider guard first: someone who may not edit the catalog here gets RLS's plain 42501 and learns nothing
  if auth.uid() is not null and not (app.can_edit_catalog(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  if new.kind is distinct from 'punch_card' then
    if tg_op = 'UPDATE' and old.kind = 'punch_card'
       and exists (select 1 from public.punch_cards c
                    where c.organization_id = new.organization_id and c.product_id = new.id and c.status <> 'cancelled') then
      raise exception 'a punch card product with live cards stays a punch card' using errcode = 'P0001', hint = 'punch_card:kind_in_use';
    end if;
    new.punch_entries := null;
    new.punch_validity_count := null;
    new.punch_validity_unit := null;
    new.punch_meeting_type_ids := null;
    return new;
  end if;
  if new.punch_meeting_type_ids is not null and cardinality(new.punch_meeting_type_ids) = 0 then
    new.punch_meeting_type_ids := null;
  end if;
  -- a person makes a punch card product, or changes its settings, only with the plan key
  if auth.uid() is not null
     and (tg_op = 'INSERT' or old.kind is distinct from 'punch_card'
          or new.punch_entries is distinct from old.punch_entries
          or new.punch_validity_count is distinct from old.punch_validity_count
          or new.punch_validity_unit is distinct from old.punch_validity_unit
          or new.punch_meeting_type_ids is distinct from old.punch_meeting_type_ids)
     and not app.org_has_feature(new.organization_id, 'punch_cards') then
    raise exception 'punch cards are not in the plan' using errcode = 'P0001', hint = 'feature:punch_cards';
  end if;
  -- the meeting types, when the list changes: each a type of this business, each once
  if new.punch_meeting_type_ids is not null
     and (tg_op = 'INSERT' or new.punch_meeting_type_ids is distinct from old.punch_meeting_type_ids) then
    select array_agg(distinct t) into v_ids from unnest(new.punch_meeting_type_ids) t;
    if array_position(new.punch_meeting_type_ids, null) is not null
       or cardinality(v_ids) <> cardinality(new.punch_meeting_type_ids)
       or (select count(*) from public.meeting_types mt
            where mt.organization_id = new.organization_id and mt.id = any(v_ids)) <> cardinality(v_ids) then
      raise exception 'the meeting types of a punch card are types of this business, each once'
        using errcode = 'P0001', hint = 'punch_card:meeting_types';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.products_punch_card() from public, anon, authenticated;

create or replace trigger products_punch_card before insert or update on public.products
  for each row execute function app.products_punch_card();

-- ----------------------------------------------------------------------------
-- The plan key on cards (a second net behind the functions)
-- ----------------------------------------------------------------------------
create or replace function app.punch_cards_feature() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- outsider guard first: only a seller of this business is told about the plan
  if auth.uid() is not null and not app.punch_card_seller(new.organization_id) then
    return new;
  end if;
  -- the foreign key's own set-null of a payment is a server write
  if pg_trigger_depth() > 1 then
    return new;
  end if;
  if (tg_op = 'INSERT'
      or (new.status = 'active' and old.status is distinct from 'active')
      or new.contact_id is distinct from old.contact_id)
     and not app.org_has_feature(new.organization_id, 'punch_cards') then
    raise exception 'punch cards are not in the plan' using errcode = 'P0001', hint = 'feature:punch_cards';
  end if;
  return new;
end;
$$;
revoke all on function app.punch_cards_feature() from public, anon, authenticated;

create or replace trigger punch_cards_feature before insert or update on public.punch_cards
  for each row execute function app.punch_cards_feature();

-- ----------------------------------------------------------------------------
-- Opening, activating, cancelling and transferring a card
-- ----------------------------------------------------------------------------
create or replace function public.punch_card_open(
  p_org uuid, p_contact uuid, p_product uuid, p_payment uuid default null, p_activate boolean default false
) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_product record;
  v_active boolean := false;
  v_id uuid;
  v_now timestamptz := now();
  v_link jsonb;
  v_price bigint;
begin
  if not app.punch_card_seller(p_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not app.punch_card_contact_ok(p_org, p_contact) then
    raise exception 'the contact is not available' using errcode = 'P0001', hint = 'punch_card:contact';
  end if;
  if not app.org_has_feature(p_org, 'punch_cards') then
    raise exception 'punch cards are not in the plan' using errcode = 'P0001', hint = 'feature:punch_cards';
  end if;
  select p.name, p.punch_entries, p.punch_validity_count, p.punch_validity_unit, p.price_agorot into v_product
    from public.products p
   where p.organization_id = p_org and p.id = p_product and p.kind = 'punch_card'
     and p.is_active and p.archived_at is null and p.punch_entries is not null
   for share;
  if not found then
    raise exception 'not an offerable punch card product' using errcode = 'P0001', hint = 'punch_card:product';
  end if;
  if p_payment is not null then
    perform 1 from public.payments pm where pm.organization_id = p_org and pm.id = p_payment for update;
    if not app.punch_card_payment_ok(p_org, p_contact, p_payment) then
      raise exception 'the payment is not a counted payment of this contact' using errcode = 'P0001', hint = 'punch_card:payment';
    end if;
    -- fourth review, finding 2: a payment on an order or quote with a free unit of this product's line takes that unit, so
    -- the line counts the card (never a second one from it); the price is then the unit's share of the document
    v_link := app.punch_card_payment_line(p_org, p_payment, p_product);
    v_price := coalesce((v_link ->> 'price')::bigint, app.punch_product_price(p_org, p_product));
    -- third review, finding 6: the payment less its live cards and its counted allocations
    if app.punch_cards_room(p_org, p_payment, (v_link ->> 'order_id')::uuid, (v_link ->> 'quote_id')::uuid, 'link') < v_price then
      raise exception 'the payment already paid for its cards' using errcode = 'P0001', hint = 'punch_card:payment_used';
    end if;
    v_active := true;
  elsif coalesce(p_activate, false) then
    if not app.is_admin(p_org) then
      raise exception 'only owners and admins activate a card by hand' using errcode = 'P0001', hint = 'punch_card:activate_admin';
    end if;
    v_active := true;
  end if;
  insert into public.punch_cards (organization_id, contact_id, product_id, name, entries_total, validity_count, validity_unit,
                                  status, payment_id, activated_at, activated_by, activated_manually, expires_on, price_agorot,
                                  order_line_id, quote_line_id, unit_no)
  values (p_org, p_contact, p_product, v_product.name, v_product.punch_entries, v_product.punch_validity_count,
          v_product.punch_validity_unit,
          case when v_active then 'active' else 'pending' end,
          p_payment,
          case when v_active then v_now end,
          case when v_active then auth.uid() end,
          v_active and p_payment is null,
          case when v_active then app.punch_card_expires_on(app.punch_card_today(p_org), v_product.punch_validity_count, v_product.punch_validity_unit) end,
          coalesce(v_price, app.punch_product_price(p_org, p_product)),
          (v_link ->> 'order_line_id')::uuid, (v_link ->> 'quote_line_id')::uuid, (v_link ->> 'unit_no')::integer)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.punch_card_open(uuid, uuid, uuid, uuid, boolean) from public, anon;
grant execute on function public.punch_card_open(uuid, uuid, uuid, uuid, boolean) to authenticated;

create or replace function public.punch_card_activate(p_org uuid, p_card uuid, p_payment uuid default null) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_card public.punch_cards;
  v_link jsonb;
begin
  if not app.punch_card_seller(p_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_card from public.punch_cards c where c.organization_id = p_org and c.id = p_card for update;
  if not found or not app.punch_card_contact_ok(p_org, v_card.contact_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_card.status <> 'pending' then
    raise exception 'only a card waiting for payment is activated' using errcode = 'P0001', hint = 'punch_card:not_pending';
  end if;
  if not app.org_has_feature(p_org, 'punch_cards') then
    raise exception 'punch cards are not in the plan' using errcode = 'P0001', hint = 'feature:punch_cards';
  end if;
  if p_payment is null then
    if not app.is_admin(p_org) then
      raise exception 'only owners and admins activate a card by hand' using errcode = 'P0001', hint = 'punch_card:activate_admin';
    end if;
  else
    perform 1 from public.payments pm where pm.organization_id = p_org and pm.id = p_payment for update;
    if not app.punch_card_payment_ok(p_org, v_card.contact_id, p_payment) then
      raise exception 'the payment is not a counted payment of this contact' using errcode = 'P0001', hint = 'punch_card:payment';
    end if;
    -- fourth review, finding 2: the payment's order or quote line of this product takes the card, as in punch_card_open
    v_link := app.punch_card_payment_line(p_org, p_payment, v_card.product_id);
    if app.punch_cards_room(p_org, p_payment, (v_link ->> 'order_id')::uuid, (v_link ->> 'quote_id')::uuid, 'link')
       < coalesce((v_link ->> 'price')::bigint, v_card.price_agorot) then
      raise exception 'the payment already paid for its cards' using errcode = 'P0001', hint = 'punch_card:payment_used';
    end if;
  end if;
  update public.punch_cards c
     set status = 'active', payment_id = p_payment, activated_at = now(), activated_by = auth.uid(),
         activated_manually = p_payment is null,
         expires_on = app.punch_card_expires_on(app.punch_card_today(p_org), c.validity_count, c.validity_unit),
         price_agorot = coalesce((v_link ->> 'price')::bigint, c.price_agorot),
         order_line_id = coalesce((v_link ->> 'order_line_id')::uuid, c.order_line_id),
         quote_line_id = coalesce((v_link ->> 'quote_line_id')::uuid, c.quote_line_id),
         unit_no = coalesce((v_link ->> 'unit_no')::integer, c.unit_no)
   where c.organization_id = p_org and c.id = p_card;
end;
$$;
revoke all on function public.punch_card_activate(uuid, uuid, uuid) from public, anon;
grant execute on function public.punch_card_activate(uuid, uuid, uuid) to authenticated;

create or replace function public.punch_card_cancel(p_org uuid, p_card uuid, p_reason text) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_status text;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if not (app.is_admin(p_org) and app.org_writable(p_org)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select c.status into v_status from public.punch_cards c where c.organization_id = p_org and c.id = p_card for update;
  if not found then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_status = 'cancelled' then
    raise exception 'the card is cancelled already' using errcode = 'P0001', hint = 'punch_card:cancelled';
  end if;
  if char_length(v_reason) not between 1 and 500 then
    raise exception 'a reason of 1 to 500 characters' using errcode = 'P0001', hint = 'punch_card:reason';
  end if;
  update public.punch_cards c
     set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = v_reason
   where c.organization_id = p_org and c.id = p_card;
end;
$$;
revoke all on function public.punch_card_cancel(uuid, uuid, text) from public, anon;
grant execute on function public.punch_card_cancel(uuid, uuid, text) to authenticated;

create or replace function public.punch_card_transfer(p_org uuid, p_card uuid, p_contact uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_card public.punch_cards;
begin
  if not (app.is_admin(p_org) and app.org_writable(p_org)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_card from public.punch_cards c where c.organization_id = p_org and c.id = p_card for update;
  if not found then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_card.status = 'cancelled' then
    raise exception 'the card is cancelled' using errcode = 'P0001', hint = 'punch_card:cancelled';
  end if;
  if p_contact is null or p_contact = v_card.contact_id or not app.punch_card_contact_ok(p_org, p_contact) then
    raise exception 'the contact is not available' using errcode = 'P0001', hint = 'punch_card:contact';
  end if;
  if not app.org_has_feature(p_org, 'punch_cards') then
    raise exception 'punch cards are not in the plan' using errcode = 'P0001', hint = 'feature:punch_cards';
  end if;
  update public.punch_cards c
     set contact_id = p_contact, transferred_at = now(), transferred_by = auth.uid(),
         former_contact_ids = case when c.contact_id = any (c.former_contact_ids) then c.former_contact_ids
                                   else c.former_contact_ids || c.contact_id end,
         holder_history = c.holder_history || jsonb_build_array(jsonb_build_object('contact', c.contact_id, 'until', now()))
   where c.organization_id = p_org and c.id = p_card;
end;
$$;
revoke all on function public.punch_card_transfer(uuid, uuid, uuid) from public, anon;
grant execute on function public.punch_card_transfer(uuid, uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Merge: the duplicate's cards go to the kept contact (before the duplicate is deleted)
-- ----------------------------------------------------------------------------
create or replace function app.merge_punch_cards() returns trigger
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
  if new.contact_id is not null and v_merged <> new.contact_id then
    update public.punch_cards c set contact_id = new.contact_id,
           former_contact_ids = case when v_merged = any (c.former_contact_ids) then c.former_contact_ids
                                     else c.former_contact_ids || v_merged end,
           holder_history = c.holder_history || jsonb_build_array(jsonb_build_object('contact', v_merged, 'until', now()))
     where c.organization_id = new.organization_id and c.contact_id = v_merged;
  end if;
  return null;
end;
$$;
revoke all on function app.merge_punch_cards() from public, anon, authenticated, service_role;

create or replace trigger activities_merge_punch_cards after insert on public.activities
  for each row
  when (new.type = 'system' and new.contact_id is not null and new.metadata ? 'merged_id')
  execute function app.merge_punch_cards();

-- ----------------------------------------------------------------------------
-- Owner (85) ב: a card opens by itself from a payment on an order or a quote with a punch card line
-- ----------------------------------------------------------------------------
-- A counted payment (recorded or confirmed) that is linked to an order (payments.order_id, advance_order_id) or a quote
-- (advance_quote_id), or allocated to a document of an order or a quote (accounting_documents.order_id / quote_id, PAY-02),
-- opens one card per punch card line and per whole unit of its quantity (at most 20 a line), never twice for the same line
-- and unit (punch_cards_order_line_unit_idx / _quote_line_unit_idx). The card is the payment's contact's, else the order's
-- or quote's contact; it is sold for the line's unit price (its total over its quantity, half up).
--
-- The room (second review, finding 2), what of the payment reached this order or quote:
--   * from an allocation: the payment's counted allocations to documents of this order (or quote), less the cards of this
--     payment already opened from this order's (or quote's) lines;
--   * from a direct link: the payment's counted amount (public.payment_counted) less its counted allocations to documents
--     of anything else, less every live card of this payment.
--   Both are also capped by the payment's own rule (app.punch_card_payment_room: its live cards never cost more than it
--   counts). A unit that does not fit waits for the next payment.
-- Quote chains (finding 3; owner (100) ב): a quote's versions (previous_id), both ways, are one chain and one purchase
-- (app.punch_quote_chain); an addendum (addendum_of) is its own purchase and opens its own cards. A quote opens nothing once
-- an order was made from any quote of its chain, and every line counts the cards already opened from the chain's lines of
-- the same product AT THE SAME POSITION (owner (101) א: versions and an order from a quote match lines by position and
-- product), so a version or the order made from it never opens a card twice; a card opened from a quote line stays linked
-- to it.
-- Concurrency (finding 4; owner (99) ב): one transaction advisory lock per order ('punch_cards:order:<org>:<order>') and per
-- quote chain ('punch_cards:quote:<org>:<root quote>'; an order made from a quote takes both), taken before the cards are
-- read; each insert is `on conflict do nothing` on the line and unit. Lock order, everywhere (no path takes them the other
-- way, so two of these paths never deadlock): first the payment rows (in id order), then the advisory keys (in ascending
-- key order, all of one call at once). The payment comes first because on two of the callers the payment is already locked
-- before this code runs (PAY-02's app.payment_allocations_check takes it FOR UPDATE before the allocation trigger, and the
-- payment trigger runs inside the payment's own write); the quote-acceptance trigger therefore locks its payments first,
-- then the chain. Payments on different orders take different keys and never wait for each other.
-- Owner (94) ב: one `system` entry per payment (app.punch_cards_note): "נפתחו N כרטיסיות אוטומטית מתשלום על הזמנה X, הצעה Y"
-- (metadata kind punch_card_opened), which a person never writes, changes or removes (app.activities_punch_card_entry_guard,
-- author cleared). Owner (93) ב: every price is with VAT (the document's stored rate and mode for a line; the business's
-- rate today for a product or a quick sale; exempt as is). Owner (95) ב: only an accepted quote opens cards; a payment made
-- before the acceptance opens them when the quote is accepted (trigger quotes_zz_punch_cards).
-- Only while the business is writable and holds the key.


-- The quotes of one chain: its versions (previous_id), both ways; an addendum is a chain of its own (owner (100) ב)
create or replace function app.punch_quote_chain(p_org uuid, p_quote uuid) returns uuid[]
language sql stable security definer
set search_path = ''
as $$
  with recursive chain(id) as (
    select p_quote where p_quote is not null
    union
    select q.id
      from chain c
      join public.quotes x on x.organization_id = p_org and x.id = c.id
      join public.quotes q on q.organization_id = p_org and (q.previous_id = c.id or q.id = x.previous_id)
  )
  select coalesce(array_agg(id), '{}') from chain
$$;
revoke all on function app.punch_quote_chain(uuid, uuid) from public, anon, authenticated, service_role;

-- The first version of a quote's chain (its lock key)
create or replace function app.punch_quote_root(p_org uuid, p_quote uuid) returns uuid
language sql stable security definer
set search_path = ''
as $$
  with recursive up(id, prev, depth) as (
    select q.id, q.previous_id, 0 from public.quotes q where q.organization_id = p_org and q.id = p_quote
    union all
    select q.id, q.previous_id, up.depth + 1
      from up join public.quotes q on q.organization_id = p_org and q.id = up.prev
     where up.depth < 1000
  )
  select id from up order by depth desc limit 1
$$;
revoke all on function app.punch_quote_root(uuid, uuid) from public, anon, authenticated, service_role;

-- Owner (99) ב: the advisory keys of an order (its own, and its quote chain's) or of a quote chain
create or replace function app.punch_card_keys(p_org uuid, p_order uuid, p_quote uuid) returns bigint[]
language sql stable security definer
set search_path = ''
as $$
  select array_remove(array[
           case when p_order is not null then hashtextextended('punch_cards:order:' || p_org::text || ':' || p_order::text, 0) end,
           (select hashtextextended('punch_cards:quote:' || p_org::text || ':' || app.punch_quote_root(p_org, x.quote)::text, 0)
              from (select coalesce(p_quote, (select o.quote_id from public.orders o where o.organization_id = p_org and o.id = p_order)) as quote) x
             where x.quote is not null)
         ], null)
$$;
revoke all on function app.punch_card_keys(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- Takes the keys in ascending order (re-entrant: a key this transaction holds is taken again at once)
create or replace function app.punch_card_lock_keys(p_keys bigint[]) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_key bigint;
begin
  for v_key in select distinct k from unnest(coalesce(p_keys, '{}'::bigint[])) k order by k loop
    perform pg_advisory_xact_lock(v_key);
  end loop;
end;
$$;
revoke all on function app.punch_card_lock_keys(bigint[]) from public, anon, authenticated, service_role;

-- Fourth review, finding 2: the free unit of a line of this product on an order or a quote the payment is linked or allocated
-- to (an order numbered and not cancelled; a quote accepted, with no order made from its chain), first by position; the
-- caller already holds the payment's row, so the keys of those orders and quotes are taken after it. Null when none.
-- Answers {order_line_id | quote_line_id, order_id | quote_id, unit_no, price} (the unit's share of the document, with VAT);
-- the caller's room then counts the payment's allocations to that order or quote as reaching it.
create or replace function app.punch_card_payment_line(p_org uuid, p_payment uuid, p_product uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_target record;
  v_line record;
  v_keys bigint[] := '{}';
  v_prices bigint[];
  v_unit integer;
begin
  for v_target in
    select x.o, x.q from (
      select pm.order_id as o, null::uuid as q from public.payments pm where pm.organization_id = p_org and pm.id = p_payment
      union select pm.advance_order_id, null from public.payments pm where pm.organization_id = p_org and pm.id = p_payment
      union select null, pm.advance_quote_id from public.payments pm where pm.organization_id = p_org and pm.id = p_payment
      union select d.order_id, null from public.payment_allocations a
              join public.accounting_documents d on d.organization_id = a.organization_id and d.id = a.document_id
             where a.organization_id = p_org and a.payment_id = p_payment and a.released_at is null and a.removed_at is null
      union select null, d.quote_id from public.payment_allocations a
              join public.accounting_documents d on d.organization_id = a.organization_id and d.id = a.document_id
             where a.organization_id = p_org and a.payment_id = p_payment and a.released_at is null and a.removed_at is null
    ) x where x.o is not null or x.q is not null
  loop
    v_keys := v_keys || app.punch_card_keys(p_org, v_target.o, v_target.q);
  end loop;
  if cardinality(v_keys) = 0 then
    return null;
  end if;
  perform app.punch_card_lock_keys(v_keys);
  for v_line in
    select 'order'::text as kind, l.order_id as doc, l.id, l.quantity, l.position
      from public.order_lines l join public.orders o on o.organization_id = l.organization_id and o.id = l.order_id
     where l.organization_id = p_org and l.product_id = p_product and o.status not in ('draft', 'cancelled')
       and l.order_id in (select pm.order_id from public.payments pm where pm.organization_id = p_org and pm.id = p_payment
                          union select pm.advance_order_id from public.payments pm where pm.organization_id = p_org and pm.id = p_payment
                          union select d.order_id from public.payment_allocations a
                                  join public.accounting_documents d on d.organization_id = a.organization_id and d.id = a.document_id
                                 where a.organization_id = p_org and a.payment_id = p_payment and a.released_at is null and a.removed_at is null)
    union all
    select 'quote', l.quote_id, l.id, l.quantity, l.position
      from public.quote_lines l join public.quotes q on q.organization_id = l.organization_id and q.id = l.quote_id
     where l.organization_id = p_org and l.product_id = p_product and l.kind = 'item' and (not l.is_optional or l.optional_selected)
       and q.status = 'accepted'
       and not exists (select 1 from public.orders o where o.organization_id = p_org and o.quote_id = any (app.punch_quote_chain(p_org, q.id)))
       and l.quote_id in (select pm.advance_quote_id from public.payments pm where pm.organization_id = p_org and pm.id = p_payment
                          union select d.quote_id from public.payment_allocations a
                                  join public.accounting_documents d on d.organization_id = a.organization_id and d.id = a.document_id
                                 where a.organization_id = p_org and a.payment_id = p_payment and a.released_at is null and a.removed_at is null)
     order by 1, 5, 3
  loop
    select min(n) into v_unit from generate_series(1, least(20, floor(v_line.quantity)::integer)) n
     where not exists (select 1 from public.punch_cards c
                        where c.organization_id = p_org and c.unit_no = n
                          and (c.order_line_id = case when v_line.kind = 'order' then v_line.id end
                               or c.quote_line_id = case when v_line.kind = 'quote' then v_line.id end));
    if v_unit is not null then
      v_prices := app.punch_line_unit_prices(p_org, v_line.kind, v_line.doc, v_line.id);
      if v_unit <= coalesce(cardinality(v_prices), 0) then
        return jsonb_build_object(case when v_line.kind = 'order' then 'order_line_id' else 'quote_line_id' end, v_line.id,
                                  case when v_line.kind = 'order' then 'order_id' else 'quote_id' end, v_line.doc,
                                  'unit_no', v_unit, 'price', v_prices[v_unit]);
      end if;
    end if;
  end loop;
  return null;
end;
$$;
revoke all on function app.punch_card_payment_line(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- What of a payment may still open cards from this order or quote (see above); p_source 'allocation' | 'link'
create or replace function app.punch_cards_room(p_org uuid, p_payment uuid, p_order uuid, p_quote uuid, p_source text) returns bigint
language sql stable security definer
set search_path = ''
as $$
  with alloc as (
    select a.amount_agorot as amount,
           coalesce((p_order is not null and d.order_id = p_order) or (p_quote is not null and d.quote_id = p_quote), false) as here
      from public.payment_allocations a
      join public.accounting_documents d on d.organization_id = a.organization_id and d.id = a.document_id
     where a.organization_id = p_org and a.payment_id = p_payment and a.released_at is null and a.removed_at is null
  ), cards as (
    select c.price_agorot as price,
           coalesce((p_order is not null and ol.order_id = p_order) or (p_quote is not null and ql.quote_id = p_quote), false) as here
      from public.punch_cards c
      left join public.order_lines ol on ol.organization_id = c.organization_id and ol.id = c.order_line_id
      left join public.quote_lines ql on ql.organization_id = c.organization_id and ql.id = c.quote_line_id
     where c.organization_id = p_org and c.payment_id = p_payment and c.status <> 'cancelled'
  ), counted as (
    select coalesce((select public.payment_counted(pm) from public.payments pm where pm.organization_id = p_org and pm.id = p_payment), 0) as amount
  )
  select least(
           case when p_source = 'allocation'
                then (select coalesce(sum(amount), 0) from alloc where here) - (select coalesce(sum(price), 0) from cards where here)
                else (select amount from counted) - (select coalesce(sum(amount), 0) from alloc where not here)
                     - (select coalesce(sum(price), 0) from cards)
           end,
           (select amount from counted) - (select coalesce(sum(price), 0) from cards))
$$;
revoke all on function app.punch_cards_room(uuid, uuid, uuid, uuid, text) from public, anon, authenticated, service_role;

-- Third review, finding 3: a whole split into parts by weight, largest remainder (ties to the earlier part); the parts
-- always sum to the whole. Pure; null on bad input.
create or replace function app.punch_split(p_total bigint, p_weights numeric[]) returns bigint[]
language sql immutable
set search_path = ''
as $$
  with w as (select o, greatest(coalesce(x, 0), 0) as x from unnest(p_weights) with ordinality as u(x, o)),
       s as (select sum(x) as total from w),
       raw as (select w.o, case when s.total > 0 then p_total * w.x / s.total else 0 end as share from w, s),
       base as (select o, floor(share)::bigint as b, share - floor(share) as frac from raw),
       left_over as (select p_total - coalesce(sum(b), 0) as n from base),
       ranked as (select o, b, row_number() over (order by frac desc, o) as r from base)
  select case when p_total is null or p_total < 0 or (select total from s) is null or (select total from s) <= 0 then null
              else (select array_agg(b + case when r <= (select n from left_over) then 1 else 0 end order by o) from ranked) end
$$;
revoke all on function app.punch_split(bigint, numeric[]) from public, anon, authenticated, service_role;

-- Third review, finding 3: the with-VAT price of each whole unit of a document line: the document's grand total (with VAT,
-- after its discount, as stored) split over its counted item lines by their with-VAT amounts, then the line's share split
-- evenly over its quantity, so the units sum exactly to what the document charges for them. p_kind 'order' | 'quote'.
create or replace function app.punch_line_unit_prices(p_org uuid, p_kind text, p_doc uuid, p_line uuid) returns bigint[]
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_total bigint;
  v_rate integer;
  v_includes boolean;
  v_ids uuid[];
  v_weights numeric[];
  v_shares bigint[];
  v_qty numeric;
  v_share bigint;
  v_units integer;
begin
  if p_kind = 'order' then
    select o.total_agorot, o.vat_rate_bp, o.prices_include_vat into v_total, v_rate, v_includes
      from public.orders o where o.organization_id = p_org and o.id = p_doc;
    select array_agg(l.id order by l.position, l.id),
           array_agg(app.punch_with_vat(l.total_agorot, v_includes, l.vat_exempt, v_rate)::numeric order by l.position, l.id)
      into v_ids, v_weights
      from public.order_lines l where l.organization_id = p_org and l.order_id = p_doc;
    select l.quantity into v_qty from public.order_lines l where l.organization_id = p_org and l.id = p_line;
  else
    select q.total_agorot, q.vat_rate_bp, q.prices_include_vat into v_total, v_rate, v_includes
      from public.quotes q where q.organization_id = p_org and q.id = p_doc;
    select array_agg(l.id order by l.position, l.id),
           array_agg(app.punch_with_vat(l.total_agorot, v_includes, l.vat_exempt, v_rate)::numeric order by l.position, l.id)
      into v_ids, v_weights
      from public.quote_lines l where l.organization_id = p_org and l.quote_id = p_doc and l.kind = 'item'
       and (not l.is_optional or l.optional_selected);
    select l.quantity into v_qty from public.quote_lines l where l.organization_id = p_org and l.id = p_line;
  end if;
  v_shares := app.punch_split(coalesce(v_total, 0), v_weights);
  if v_shares is null or v_qty is null or v_qty <= 0 then
    return '{}';
  end if;
  v_share := v_shares[array_position(v_ids, p_line)];
  v_units := least(20, floor(v_qty)::integer);
  if v_share is null or v_units < 1 then
    return '{}';
  end if;
  if v_qty = floor(v_qty) then
    -- the line's share over its whole quantity; the first 20 units
    return (app.punch_split(v_share, array_fill(1::numeric, array[floor(v_qty)::integer])))[1:v_units];
  end if;
  -- a quantity with a fraction: each whole unit at the share over the quantity, half up
  return array_fill(round(v_share / v_qty)::bigint, array[v_units]);
end;
$$;
revoke all on function app.punch_line_unit_prices(uuid, text, uuid, uuid) from public, anon, authenticated, service_role;

-- Third review, finding 4: an automatic opening that failed is never silent: one `system` notice to the business's active
-- owners and admins, naming the payment's customer (link only; no amount, no name in the text). Never raises.
create or replace function app.punch_cards_failed_notice(p_org uuid, p_payment uuid, p_contact uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select p_org, m.user_id, 'system', 'כרטיסייה לא נפתחה אוטומטית',
         'נרשם תשלום שאמור לפתוח כרטיסייה, אבל הפתיחה האוטומטית לא הצליחה. המערכת תנסה שוב בעצמה; אפשר גם לפתוח אותה ידנית מהכרטיסיות של הלקוח.',
         case when p_contact is not null then 'contact' end, p_contact
    from public.memberships m
   where m.organization_id = p_org and m.status = 'active' and m.role in ('owner', 'admin');
exception when others then
  raise warning 'punch_cards_failed_notice: payment % (%)', p_payment, sqlstate;
end;
$$;
revoke all on function app.punch_cards_failed_notice(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- Owner (109) ב: an automatic opening (or a payment's cards judged again) that failed inside the payment's, allocation's or
-- acceptance's transaction is never lost: one row here (ids and codes only), tried again by pg_cron
-- `crm-punch-card-retry` (app.retry_punch_card_openings, every 5 minutes) until it is done, or given up after 3 days with
-- one `system` notice to the business's active owners and admins. Schema app: RLS on, no policies, no grants. A deleted
-- payment, order, quote or allocation takes its rows with it. Done rows keep `done_at` (removing old rows needs a delete,
-- which lives in a hand-pasted migration; not written yet).
create table if not exists app.punch_card_retries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- open = one payment's cards of one order or quote; quote = every payment of a quote at its acceptance; void_sync = one
  -- payment's cards judged again (app.punch_cards_void_sync)
  kind text not null check (kind in ('open', 'quote', 'void_sync')),
  payment_id uuid,
  order_id uuid,
  quote_id uuid,
  allocation_id uuid,
  source text check (source in ('link', 'allocation')),
  attempts integer not null default 0 check (attempts >= 0),
  -- the cards the finished try opened (null while waiting, for a void_sync row, or a row closed because the key is gone)
  opened integer check (opened >= 0),
  next_try_at timestamptz not null default now() + interval '5 minutes',
  last_sqlstate text check (last_sqlstate ~ '^[0-9A-Z]{5}$'),
  created_at timestamptz not null default now(),
  done_at timestamptz,
  given_up_at timestamptz,
  constraint punch_card_retries_shape check (
    (kind = 'open' and payment_id is not null and source is not null and num_nonnulls(order_id, quote_id) = 1)
    or (kind = 'quote' and quote_id is not null and payment_id is null and order_id is null and allocation_id is null and source is null)
    or (kind = 'void_sync' and payment_id is not null and order_id is null and quote_id is null and allocation_id is null and source is null)
  ),
  constraint punch_card_retries_one_end check (done_at is null or given_up_at is null),
  foreign key (organization_id, payment_id) references public.payments (organization_id, id) on delete cascade,
  foreign key (organization_id, order_id) references public.orders (organization_id, id) on delete cascade,
  foreign key (organization_id, quote_id) references public.quotes (organization_id, id) on delete cascade,
  foreign key (organization_id, allocation_id) references public.payment_allocations (organization_id, id) on delete cascade
);
alter table app.punch_card_retries enable row level security;
revoke all on table app.punch_card_retries from public, anon, authenticated, service_role;
-- the payment and quote indexes also serve app.punch_card_retry_event_end's sibling read
create index if not exists punch_card_retries_payment_idx on app.punch_card_retries (organization_id, payment_id);
create index if not exists punch_card_retries_order_idx on app.punch_card_retries (organization_id, order_id);
create index if not exists punch_card_retries_quote_idx on app.punch_card_retries (organization_id, quote_id);
create index if not exists punch_card_retries_allocation_idx on app.punch_card_retries (organization_id, allocation_id);
create index if not exists punch_card_retries_due_idx on app.punch_card_retries (next_try_at)
  where done_at is null and given_up_at is null;
-- one waiting row per event: a second failure of the same opening before it is retried adds nothing
create unique index if not exists punch_card_retries_waiting on app.punch_card_retries (
  organization_id, kind,
  coalesce(payment_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(order_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(quote_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(source, '')
) where done_at is null and given_up_at is null;

-- The wait before the next try after `p_attempts` tries: 5 minutes before the first, then 15 minutes, then every hour
create or replace function app.punch_card_retry_delay(p_attempts integer) returns interval
language sql immutable
set search_path = ''
as $$
  select case when coalesce(p_attempts, 0) <= 0 then interval '5 minutes'
              when p_attempts = 1 then interval '15 minutes'
              else interval '1 hour' end
$$;
revoke all on function app.punch_card_retry_delay(integer) from public, anon, authenticated, service_role;

-- How long a row is tried before it is given up
create or replace function app.punch_card_retry_window() returns interval
language sql immutable
set search_path = ''
as $$
  select interval '3 days'
$$;
revoke all on function app.punch_card_retry_window() from public, anon, authenticated, service_role;

-- Records one failed step for the retry job. Called from an exception handler; never raises (a failure here leaves one
-- warning, and the notice the caller sends still tells the owners).
create or replace function app.punch_card_retry_record(p_org uuid, p_kind text, p_payment uuid, p_order uuid, p_quote uuid,
                                                       p_allocation uuid, p_source text, p_sqlstate text) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into app.punch_card_retries (organization_id, kind, payment_id, order_id, quote_id, allocation_id, source, last_sqlstate,
                                      next_try_at)
  values (p_org, p_kind, p_payment, p_order, p_quote, p_allocation, p_source,
          case when p_sqlstate ~ '^[0-9A-Z]{5}$' then p_sqlstate end, now() + app.punch_card_retry_delay(0))
  on conflict (organization_id, kind,
               coalesce(payment_id, '00000000-0000-0000-0000-000000000000'::uuid),
               coalesce(order_id, '00000000-0000-0000-0000-000000000000'::uuid),
               coalesce(quote_id, '00000000-0000-0000-0000-000000000000'::uuid),
               coalesce(source, ''))
    where done_at is null and given_up_at is null
  do nothing;
exception when others then
  raise warning 'punch_card_retry_record: payment % quote % was not kept for a retry (%)', p_payment, p_quote, sqlstate;
end;
$$;
revoke all on function app.punch_card_retry_record(uuid, text, uuid, uuid, uuid, uuid, text, text) from public, anon, authenticated, service_role;

-- The notice when the retries give up (one per row): names the customer by link only, no amount, no name in the text
create or replace function app.punch_cards_gave_up_notice(p_org uuid, p_kind text, p_payment uuid, p_quote uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_contact uuid;
begin
  v_contact := coalesce((select pm.contact_id from public.payments pm where pm.organization_id = p_org and pm.id = p_payment),
                        (select q.contact_id from public.quotes q where q.organization_id = p_org and q.id = p_quote));
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select p_org, m.user_id, 'system', 'כרטיסייה לא נפתחה גם בניסיונות חוזרים',
         case when p_kind = 'void_sync'
              then 'המערכת ניסתה במשך שלושה ימים לבדוק אם תשלום עדיין מכסה את הכרטיסיות שלו, ולא הצליחה. כדאי לבדוק את הכרטיסיות של הלקוח.'
              else 'המערכת ניסתה במשך שלושה ימים לפתוח כרטיסייה מתשלום, ולא הצליחה. צריך לפתוח אותה ידנית מהכרטיסיות של הלקוח.' end,
         case when v_contact is not null then 'contact' end, v_contact
    from public.memberships m
   where m.organization_id = p_org and m.status = 'active' and m.role in ('owner', 'admin');
exception when others then
  raise warning 'punch_cards_gave_up_notice: payment % quote % (%)', p_payment, p_quote, sqlstate;
end;
$$;
revoke all on function app.punch_cards_gave_up_notice(uuid, text, uuid, uuid) from public, anon, authenticated, service_role;

-- Fifth review, finding 4: a retry that ended with nothing to open (the payment stopped counting or moved, the allocation was
-- undone, no room left, the quote is no longer accepted, or the card was opened meanwhile). Same recipients, nothing personal,
-- no amount. Never raises.
create or replace function app.punch_cards_retry_empty_notice(p_org uuid, p_payment uuid, p_quote uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_contact uuid;
begin
  v_contact := coalesce((select pm.contact_id from public.payments pm where pm.organization_id = p_org and pm.id = p_payment),
                        (select q.contact_id from public.quotes q where q.organization_id = p_org and q.id = p_quote));
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select p_org, m.user_id, 'system', 'הניסיון החוזר לפתוח כרטיסייה הסתיים',
         'הניסיון החוזר הסתיים בלי לפתוח כרטיסייה, כי המצב השתנה בינתיים (למשל התשלום בוטל או הועבר, או שהכרטיסייה כבר נפתחה). כדאי לבדוק את הכרטיסיות של הלקוח.',
         case when v_contact is not null then 'contact' end, v_contact
    from public.memberships m
   where m.organization_id = p_org and m.status = 'active' and m.role in ('owner', 'admin');
exception when others then
  raise warning 'punch_cards_retry_empty_notice: payment % quote % (%)', p_payment, p_quote, sqlstate;
end;
$$;
revoke all on function app.punch_cards_retry_empty_notice(uuid, uuid, uuid) from public, anon, authenticated, service_role;

create or replace function app.punch_cards_auto_open(p_org uuid, p_payment uuid, p_order uuid, p_quote uuid, p_source text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_pay record;
  v_contact uuid;
  v_doc_contact uuid;
  v_number text;
  v_status text;
  -- second review, finding 1: the order's own quote, a scalar (a record filled from quotes has no quote_id)
  v_order_quote uuid;
  v_chain uuid[] := '{}';
  v_line record;
  v_target integer;
  v_have integer;
  v_unit integer;
  v_price bigint;
  v_room bigint;
  v_card uuid;
  v_opened integer := 0;
  v_rate integer;
  v_includes boolean;
  v_prices bigint[];
  v_none constant jsonb := jsonb_build_object('opened', 0);
begin
  if p_payment is null or (p_order is null and p_quote is null)
     or not app.org_has_feature(p_org, 'punch_cards') or not app.org_writable(p_org) then
    return v_none;
  end if;
  -- the payment first, then the order's / chain's keys (the order every caller keeps)
  select pm.id, pm.contact_id, pm.status, pm.order_id, pm.advance_order_id, pm.advance_quote_id into v_pay from public.payments pm
   where pm.organization_id = p_org and pm.id = p_payment for update;
  if not found or v_pay.status not in ('recorded', 'confirmed') then
    return v_none;
  end if;
  -- fifth review, finding 1: a linked payment opens only on the order or quote it is linked to NOW (an owner/admin may move
  -- or remove an advance's link after the payment was recorded; a retry must never open on the old one). An allocation's
  -- reach is its counted allocations (app.punch_cards_room).
  if p_source = 'link'
     and not coalesce((p_order is not null and (p_order = v_pay.order_id or p_order = v_pay.advance_order_id))
                      or (p_order is null and p_quote is not null and p_quote = v_pay.advance_quote_id), false) then
    return v_none;
  end if;
  perform app.punch_card_lock_keys(app.punch_card_keys(p_org, p_order, p_quote));
  if p_order is not null then
    select o.contact_id, o.number_display, o.status, o.quote_id, o.vat_rate_bp, o.prices_include_vat
      into v_doc_contact, v_number, v_status, v_order_quote, v_rate, v_includes
      from public.orders o where o.organization_id = p_org and o.id = p_order;
    if not found or v_status in ('draft', 'cancelled') then
      return v_none;
    end if;
    if v_order_quote is not null then
      v_chain := app.punch_quote_chain(p_org, v_order_quote);
    end if;
  else
    select q.contact_id, q.number_display, q.status, q.vat_rate_bp, q.prices_include_vat
      into v_doc_contact, v_number, v_status, v_rate, v_includes
      from public.quotes q where q.organization_id = p_org and q.id = p_quote;
    -- owner (95) ב: only an accepted quote opens cards (a payment made before the acceptance opens them at the acceptance)
    if not found or v_status <> 'accepted' then
      return v_none;
    end if;
    v_chain := app.punch_quote_chain(p_org, p_quote);
    if exists (select 1 from public.orders o where o.organization_id = p_org and o.quote_id = any (v_chain)) then
      return v_none;
    end if;
  end if;
  v_contact := coalesce(v_pay.contact_id, v_doc_contact);
  if v_contact is null
     or not exists (select 1 from public.contacts c where c.organization_id = p_org and c.id = v_contact and c.deleted_at is null) then
    return v_none;
  end if;
  v_room := app.punch_cards_room(p_org, p_payment, p_order, p_quote, p_source);
  for v_line in
    select l.id, l.product_id, l.quantity, l.total_agorot, l.position, l.vat_exempt, p.name, p.punch_entries, p.punch_validity_count, p.punch_validity_unit
      from public.order_lines l
      join public.products p on p.organization_id = l.organization_id and p.id = l.product_id
     where p_order is not null and l.organization_id = p_org and l.order_id = p_order
       and p.kind = 'punch_card' and p.punch_entries is not null
    union all
    select l.id, l.product_id, l.quantity, l.total_agorot, l.position, l.vat_exempt, p.name, p.punch_entries, p.punch_validity_count, p.punch_validity_unit
      from public.quote_lines l
      join public.products p on p.organization_id = l.organization_id and p.id = l.product_id
     where p_order is null and l.organization_id = p_org and l.quote_id = p_quote and l.kind = 'item'
       and (not l.is_optional or l.optional_selected)
       and p.kind = 'punch_card' and p.punch_entries is not null
     order by 5, 1
  loop
    v_target := least(20, floor(v_line.quantity)::integer);
    if v_target < 1 then
      continue;
    end if;
    -- owner (93) ב, third review finding 3: each unit's price with VAT, its exact share of what the document charges
    v_prices := app.punch_line_unit_prices(p_org, case when p_order is not null then 'order' else 'quote' end,
                                           coalesce(p_order, p_quote), v_line.id);
    -- the cards this line, and the chain's lines of the same product at the same position, opened already
    v_have := (select count(*) from public.punch_cards c
                where c.organization_id = p_org
                  and (c.order_line_id = case when p_order is not null then v_line.id end
                       or c.quote_line_id = case when p_order is null then v_line.id end))
            + (select count(*) from public.punch_cards c
                join public.quote_lines ql on ql.organization_id = c.organization_id and ql.id = c.quote_line_id
               where c.organization_id = p_org and ql.quote_id = any (v_chain) and ql.product_id = v_line.product_id
                 and ql.position = v_line.position and ql.id <> v_line.id
                 -- third review, finding 2: only OTHER quotes of the chain (a quote's own lines are counted above)
                 and ql.quote_id is distinct from p_quote);
    while v_have < v_target loop
      -- the line's next free unit
      select min(n) into v_unit from generate_series(1, 20) n
       where not exists (select 1 from public.punch_cards c
                          where c.organization_id = p_org and c.unit_no = n
                            and (c.order_line_id = case when p_order is not null then v_line.id end
                                 or c.quote_line_id = case when p_order is null then v_line.id end));
      if v_unit is null or v_unit > coalesce(cardinality(v_prices), 0) then
        exit;
      end if;
      v_price := v_prices[v_unit];
      if v_room < v_price or not app.punch_card_payment_room(p_org, p_payment, v_price) then
        exit;
      end if;
      v_card := null;
      if p_order is not null then
        insert into public.punch_cards (organization_id, contact_id, product_id, name, entries_total, validity_count, validity_unit,
                                        status, payment_id, activated_at, activated_by, expires_on, price_agorot, order_line_id, unit_no)
        values (p_org, v_contact, v_line.product_id, v_line.name, v_line.punch_entries, v_line.punch_validity_count,
                v_line.punch_validity_unit, 'active', p_payment, now(), auth.uid(),
                app.punch_card_expires_on(app.punch_card_today(p_org), v_line.punch_validity_count, v_line.punch_validity_unit),
                v_price, v_line.id, v_unit)
        on conflict (organization_id, order_line_id, unit_no) where order_line_id is not null do nothing
        returning id into v_card;
      else
        insert into public.punch_cards (organization_id, contact_id, product_id, name, entries_total, validity_count, validity_unit,
                                        status, payment_id, activated_at, activated_by, expires_on, price_agorot, quote_line_id, unit_no)
        values (p_org, v_contact, v_line.product_id, v_line.name, v_line.punch_entries, v_line.punch_validity_count,
                v_line.punch_validity_unit, 'active', p_payment, now(), auth.uid(),
                app.punch_card_expires_on(app.punch_card_today(p_org), v_line.punch_validity_count, v_line.punch_validity_unit),
                v_price, v_line.id, v_unit)
        on conflict (organization_id, quote_line_id, unit_no) where quote_line_id is not null do nothing
        returning id into v_card;
      end if;
      v_have := v_have + 1;
      if v_card is null then
        continue;
      end if;
      v_room := v_room - v_price;
      v_opened := v_opened + 1;
    end loop;
  end loop;
  -- owner (94) ב: the caller writes one timeline entry per payment, naming the documents
  return jsonb_build_object('opened', v_opened, 'contact', v_contact,
                            'label', case when p_order is not null then 'הזמנה ' else 'הצעה ' end || coalesce(v_number, ''));
end;
$$;
revoke all on function app.punch_cards_auto_open(uuid, uuid, uuid, uuid, text) from public, anon, authenticated, service_role;

-- Owner (94) ב: ONE timeline entry per payment and contact: "נפתחו N כרטיסיות אוטומטית מתשלום על הזמנה X, הצעה Y"
-- (one card: "נפתחה כרטיסייה אוטומטית מתשלום על …"). p_results is the answers of app.punch_cards_auto_open.
create or replace function app.punch_cards_note(p_org uuid, p_payment uuid, p_results jsonb) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  for v_row in
    select (r ->> 'contact')::uuid as contact, sum((r ->> 'opened')::integer) as opened,
           string_agg(distinct r ->> 'label', ', ') as labels
      from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) r
     where coalesce((r ->> 'opened')::integer, 0) > 0 and r ->> 'contact' is not null
     group by 1
  loop
    insert into public.activities (organization_id, type, body, contact_id, created_by, metadata)
    values (p_org, 'system',
            case when v_row.opened = 1 then 'נפתחה כרטיסייה אוטומטית מתשלום על ' || v_row.labels
                 else 'נפתחו ' || v_row.opened || ' כרטיסיות אוטומטית מתשלום על ' || v_row.labels end,
            v_row.contact, null,
            jsonb_build_object('kind', 'punch_card_opened', 'payment_id', p_payment, 'count', v_row.opened));
  end loop;
end;
$$;
revoke all on function app.punch_cards_note(uuid, uuid, jsonb) from public, anon, authenticated, service_role;

-- Review finding 1, second review finding 7: a card is marked when its payment no longer covers it: the payment stopped
-- counting, or a refund or a correction left it counting less than its live cards' prices; the mark goes when it covers
-- them again. Cards of a quick sale (deal_line_id) are covered by the sale's counted payments together. The cards are
-- locked in id order first (the order the meeting trigger takes them in). Never cancels a card.
create or replace function app.punch_cards_void_sync(p_org uuid, p_payment uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_pay record;
  v_ok boolean;
begin
  select pm.id, pm.deal_id, pm.contact_id, pm.status, public.payment_counted(pm) as counted into v_pay
    from public.payments pm where pm.organization_id = p_org and pm.id = p_payment;
  if not found then
    return;
  end if;
  perform 1 from public.punch_cards c
    where c.organization_id = p_org
      and (c.payment_id = p_payment
           or (v_pay.deal_id is not null and c.deal_line_id in (select dl.id from public.deal_lines dl
                                                                  where dl.organization_id = p_org and dl.deal_id = v_pay.deal_id)))
    order by c.id
    for update;
  v_ok := v_pay.status in ('recorded', 'confirmed')
          and v_pay.counted >= coalesce((select sum(c.price_agorot) from public.punch_cards c
                                          where c.organization_id = p_org and c.payment_id = p_payment
                                            and c.deal_line_id is null and c.status <> 'cancelled'), 0);
  update public.punch_cards c
     set payment_void_at = case when v_ok then null else now() end
   where c.organization_id = p_org and c.payment_id = p_payment and c.deal_line_id is null
     and (c.payment_void_at is null) = not v_ok;
  if v_pay.deal_id is not null then
    v_ok := coalesce((select sum(public.payment_counted(pm)) from public.payments pm
                       where pm.organization_id = p_org and pm.deal_id = v_pay.deal_id and pm.status in ('recorded', 'confirmed')), 0)
            >= coalesce((select sum(c.price_agorot) from public.punch_cards c
                          join public.deal_lines dl on dl.organization_id = c.organization_id and dl.id = c.deal_line_id
                         where c.organization_id = p_org and dl.deal_id = v_pay.deal_id and c.status <> 'cancelled'), 0);
    update public.punch_cards c
       set payment_void_at = case when v_ok then null else now() end
     where c.organization_id = p_org
       and c.deal_line_id in (select dl.id from public.deal_lines dl where dl.organization_id = p_org and dl.deal_id = v_pay.deal_id)
       and (c.payment_void_at is null) = not v_ok;
  end if;
end;
$$;
revoke all on function app.punch_cards_void_sync(uuid, uuid) from public, anon, authenticated, service_role;

-- Re-review N1: does an order, or a quote, carry a punch card line at all? A plain read that takes no lock, asked before the
-- keys, so a business that sells no punch card (or an order without one) never waits on a key nor leaves a retry row. Its
-- lines cannot change under it where it matters: a numbered order and a sent quote are frozen, and only those open cards.
create or replace function app.punch_doc_has_lines(p_org uuid, p_order uuid, p_quote uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (p_order is not null and exists (
            select 1 from public.order_lines l
              join public.products p on p.organization_id = l.organization_id and p.id = l.product_id
             where l.organization_id = p_org and l.order_id = p_order and p.kind = 'punch_card' and p.punch_entries is not null))
      or (p_quote is not null and exists (
            select 1 from public.quote_lines l
              join public.products p on p.organization_id = l.organization_id and p.id = l.product_id
             where l.organization_id = p_org and l.quote_id = p_quote and l.kind = 'item'
               and p.kind = 'punch_card' and p.punch_entries is not null))
$$;
revoke all on function app.punch_doc_has_lines(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- The payment side: a payment whose status or amount changed is judged again (marks above); a payment that counts (new, or
-- turning to recorded/confirmed, or newly linked) opens the cards of the order or quote it is linked to. Outsider guard
-- first. Each opening runs in its own block (finding 8): an error is caught with one warning naming the payment and never
-- fails the payment's write, nor undoes another call's cards.
create or replace function app.payments_punch_cards() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_counts boolean := new.status in ('recorded', 'confirmed');
  v_counted boolean := tg_op = 'UPDATE' and old.status in ('recorded', 'confirmed');
  v_results jsonb := '[]'::jsonb;
  -- fourth review, finding 6: one notice per payment event, however many steps failed
  v_failed boolean := false;
begin
  if auth.uid() is not null and not app.is_member(new.organization_id) then
    return null;
  end if;
  -- third review, finding 5: never fails the payment's write
  if tg_op = 'UPDATE' and (new.status is distinct from old.status or new.amount_agorot is distinct from old.amount_agorot) then
    begin
      perform app.punch_cards_void_sync(new.organization_id, new.id);
    exception when others then
      raise warning 'payments_punch_cards: the cards of payment % were not judged again (%)', new.id, sqlstate;
      perform app.punch_card_retry_record(new.organization_id, 'void_sync', new.id, null, null, null, null, sqlstate);
      v_failed := true;
    end;
  end if;
  if not v_counts or (new.order_id is null and new.advance_order_id is null and new.advance_quote_id is null) then
    if v_failed then
      perform app.punch_cards_failed_notice(new.organization_id, new.id, new.contact_id);
    end if;
    return null;
  end if;
  if tg_op = 'UPDATE' and v_counted
     and new.order_id is not distinct from old.order_id
     and new.advance_order_id is not distinct from old.advance_order_id
     and new.advance_quote_id is not distinct from old.advance_quote_id then
    if v_failed then
      perform app.punch_cards_failed_notice(new.organization_id, new.id, new.contact_id);
    end if;
    return null;
  end if;
  -- re-review N1: nothing to open without the plan key or a punch card line on a linked order or quote (no key, no row)
  if not app.org_has_feature(new.organization_id, 'punch_cards')
     or not (app.punch_doc_has_lines(new.organization_id, new.order_id, null)
             or app.punch_doc_has_lines(new.organization_id, new.advance_order_id, null)
             or app.punch_doc_has_lines(new.organization_id, null, new.advance_quote_id)) then
    if v_failed then
      perform app.punch_cards_failed_notice(new.organization_id, new.id, new.contact_id);
    end if;
    return null;
  end if;
  -- the payment row is locked by its own write; every key of this payment's openings now, in ascending order
  begin
    perform app.punch_card_lock_keys(app.punch_card_keys(new.organization_id, new.order_id, null)
                                     || app.punch_card_keys(new.organization_id, new.advance_order_id, null)
                                     || app.punch_card_keys(new.organization_id, null, new.advance_quote_id));
  exception when others then
    raise warning 'payments_punch_cards: no card was opened for payment % (%)', new.id, sqlstate;
    -- owner (109) ב: each opening of this payment waits for the retry job
    if new.order_id is not null then
      perform app.punch_card_retry_record(new.organization_id, 'open', new.id, new.order_id, null, null, 'link', sqlstate);
    end if;
    if new.advance_order_id is not null and new.advance_order_id is distinct from new.order_id then
      perform app.punch_card_retry_record(new.organization_id, 'open', new.id, new.advance_order_id, null, null, 'link', sqlstate);
    end if;
    if new.advance_quote_id is not null then
      perform app.punch_card_retry_record(new.organization_id, 'open', new.id, null, new.advance_quote_id, null, 'link', sqlstate);
    end if;
    perform app.punch_cards_failed_notice(new.organization_id, new.id, new.contact_id);
    return null;
  end;
  if new.order_id is not null then
    begin
      v_results := v_results || jsonb_build_array(app.punch_cards_auto_open(new.organization_id, new.id, new.order_id, null, 'link'));
    exception when others then
      raise warning 'payments_punch_cards: no card was opened for payment % from its order (%)', new.id, sqlstate;
      perform app.punch_card_retry_record(new.organization_id, 'open', new.id, new.order_id, null, null, 'link', sqlstate);
      v_failed := true;
    end;
  end if;
  if new.advance_order_id is not null and new.advance_order_id is distinct from new.order_id then
    begin
      v_results := v_results || jsonb_build_array(app.punch_cards_auto_open(new.organization_id, new.id, new.advance_order_id, null, 'link'));
    exception when others then
      raise warning 'payments_punch_cards: no card was opened for payment % from its advance order (%)', new.id, sqlstate;
      perform app.punch_card_retry_record(new.organization_id, 'open', new.id, new.advance_order_id, null, null, 'link', sqlstate);
      v_failed := true;
    end;
  end if;
  if new.advance_quote_id is not null then
    begin
      v_results := v_results || jsonb_build_array(app.punch_cards_auto_open(new.organization_id, new.id, null, new.advance_quote_id, 'link'));
    exception when others then
      raise warning 'payments_punch_cards: no card was opened for payment % from its quote (%)', new.id, sqlstate;
      perform app.punch_card_retry_record(new.organization_id, 'open', new.id, null, new.advance_quote_id, null, 'link', sqlstate);
      v_failed := true;
    end;
  end if;
  begin
    perform app.punch_cards_note(new.organization_id, new.id, v_results);
  exception when others then
    raise warning 'payments_punch_cards: the timeline entry of payment % was not written (%)', new.id, sqlstate;
  end;
  if v_failed then
    perform app.punch_cards_failed_notice(new.organization_id, new.id, new.contact_id);
  end if;
  return null;
end;
$$;
revoke all on function app.payments_punch_cards() from public, anon, authenticated, service_role;

create or replace trigger payments_zz_punch_cards after insert or update on public.payments
  for each row execute function app.payments_punch_cards();

-- Finding 7: a refund (PAY-08) made or cancelled judges its payment's cards again
create or replace function app.payment_refunds_punch_cards() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and not app.is_member(new.organization_id) then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.status is not distinct from old.status and new.amount_agorot is not distinct from old.amount_agorot then
    return null;
  end if;
  begin
    perform app.punch_cards_void_sync(new.organization_id, new.payment_id);
  exception when others then
    raise warning 'payment_refunds_punch_cards: the cards of payment % were not judged again (%)', new.payment_id, sqlstate;
    perform app.punch_card_retry_record(new.organization_id, 'void_sync', new.payment_id, null, null, null, null, sqlstate);
    perform app.punch_cards_failed_notice(new.organization_id, new.payment_id,
                                          (select pm.contact_id from public.payments pm where pm.organization_id = new.organization_id and pm.id = new.payment_id));
  end;
  return null;
end;
$$;
revoke all on function app.payment_refunds_punch_cards() from public, anon, authenticated, service_role;

create or replace trigger payment_refunds_zz_punch_cards after insert or update on public.payment_refunds
  for each row execute function app.payment_refunds_punch_cards();

-- The allocation side (PAY-02): a payment allocated to a document of an order or a quote opens that order's or quote's cards
create or replace function app.payment_allocations_punch_cards() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order uuid;
  v_quote uuid;
  v_results jsonb := '[]'::jsonb;
  v_failed boolean := false;
begin
  if auth.uid() is not null and not app.is_member(new.organization_id) then
    return null;
  end if;
  if new.released_at is not null or new.removed_at is not null then
    return null;
  end if;
  select d.order_id, d.quote_id into v_order, v_quote from public.accounting_documents d
   where d.organization_id = new.organization_id and d.id = new.document_id;
  -- re-review N1: nothing to open without the plan key or a punch card line on the document's order or quote
  if not app.org_has_feature(new.organization_id, 'punch_cards')
     or not (app.punch_doc_has_lines(new.organization_id, v_order, null)
             or app.punch_doc_has_lines(new.organization_id, null, v_quote)) then
    return null;
  end if;
  -- the payment (and the document) are locked by PAY-02's check before this trigger; then the keys, ascending
  begin
    perform app.punch_card_lock_keys(app.punch_card_keys(new.organization_id, v_order, null)
                                     || app.punch_card_keys(new.organization_id, null, v_quote));
  exception when others then
    raise warning 'payment_allocations_punch_cards: no card was opened for allocation % (%)', new.id, sqlstate;
    if v_order is not null then
      perform app.punch_card_retry_record(new.organization_id, 'open', new.payment_id, v_order, null, new.id, 'allocation', sqlstate);
    end if;
    if v_quote is not null then
      perform app.punch_card_retry_record(new.organization_id, 'open', new.payment_id, null, v_quote, new.id, 'allocation', sqlstate);
    end if;
    perform app.punch_cards_failed_notice(new.organization_id, new.payment_id,
                                          (select pm.contact_id from public.payments pm where pm.organization_id = new.organization_id and pm.id = new.payment_id));
    return null;
  end;
  if v_order is not null then
    begin
      v_results := v_results || jsonb_build_array(app.punch_cards_auto_open(new.organization_id, new.payment_id, v_order, null, 'allocation'));
    exception when others then
      raise warning 'payment_allocations_punch_cards: no card was opened for allocation % from its order (%)', new.id, sqlstate;
      perform app.punch_card_retry_record(new.organization_id, 'open', new.payment_id, v_order, null, new.id, 'allocation', sqlstate);
      v_failed := true;
    end;
  end if;
  if v_quote is not null then
    begin
      v_results := v_results || jsonb_build_array(app.punch_cards_auto_open(new.organization_id, new.payment_id, null, v_quote, 'allocation'));
    exception when others then
      raise warning 'payment_allocations_punch_cards: no card was opened for allocation % from its quote (%)', new.id, sqlstate;
      perform app.punch_card_retry_record(new.organization_id, 'open', new.payment_id, null, v_quote, new.id, 'allocation', sqlstate);
      v_failed := true;
    end;
  end if;
  begin
    perform app.punch_cards_note(new.organization_id, new.payment_id, v_results);
  exception when others then
    raise warning 'payment_allocations_punch_cards: the timeline entry of allocation % was not written (%)', new.id, sqlstate;
  end;
  if v_failed then
    perform app.punch_cards_failed_notice(new.organization_id, new.payment_id,
                                          (select pm.contact_id from public.payments pm where pm.organization_id = new.organization_id and pm.id = new.payment_id));
  end if;
  return null;
end;
$$;
revoke all on function app.payment_allocations_punch_cards() from public, anon, authenticated, service_role;

create or replace trigger payment_allocations_zz_punch_cards after insert on public.payment_allocations
  for each row execute function app.payment_allocations_punch_cards();

-- Owner (95) ב: a quote that becomes accepted opens the cards of the payments already linked to it (an advance) or
-- allocated to its documents, whoever accepted it (staff, or the customer through quote_public_decide / quote_public_answer,
-- where auth.uid() is null). Outsider guard first; each payment in its own block, never failing the decision's write; one
-- timeline entry per payment.
-- The counted payments linked to a quote (an advance) or allocated to its documents, with the opening's source
create or replace function app.punch_quote_payments(p_org uuid, p_quote uuid) returns table (id uuid, source text)
language sql stable security definer
set search_path = ''
as $$
  select pm.id, 'link'::text from public.payments pm
   where pm.organization_id = p_org and pm.advance_quote_id = p_quote and pm.status in ('recorded', 'confirmed')
  union
  select a.payment_id, 'allocation' from public.payment_allocations a
    join public.accounting_documents d on d.organization_id = a.organization_id and d.id = a.document_id
   where a.organization_id = p_org and d.quote_id = p_quote and a.released_at is null and a.removed_at is null
$$;
revoke all on function app.punch_quote_payments(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function app.quotes_punch_cards() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_pay record;
  v_results jsonb;
  v_ids uuid[];
  v_more uuid[];
  v_failed boolean := false;
begin
  if auth.uid() is not null and not app.is_member(new.organization_id) then
    return null;
  end if;
  -- re-review N1: nothing to open without the plan key or a punch card line on the quote
  if not app.org_has_feature(new.organization_id, 'punch_cards') or not app.punch_doc_has_lines(new.organization_id, null, new.id) then
    return null;
  end if;
  -- fourth review, finding 1: the payments seen now (perhaps none), then ALWAYS the chain's key, then the payments again: a
  -- payment whose own opening read this quote before the acceptance committed holds the key until it commits, and is seen
  -- here once it has
  begin
    select coalesce(array_agg(distinct x.id), '{}') into v_ids from app.punch_quote_payments(new.organization_id, new.id) x;
    perform 1 from public.payments pm where pm.organization_id = new.organization_id and pm.id = any (v_ids) order by pm.id for update;
    perform app.punch_card_lock_keys(app.punch_card_keys(new.organization_id, null, new.id));
    select coalesce(array_agg(distinct x.id), '{}') into v_more from app.punch_quote_payments(new.organization_id, new.id) x
     where not (x.id = any (v_ids));
    -- owner (106) א: a payment row is never waited for after a key: one still held elsewhere is not waited for (nowait)
    perform 1 from public.payments pm where pm.organization_id = new.organization_id and pm.id = any (v_more) order by pm.id for update nowait;
  exception when others then
    raise warning 'quotes_punch_cards: no card was opened at the acceptance of quote % (%)', new.id, sqlstate;
    perform app.punch_card_retry_record(new.organization_id, 'quote', null, null, new.id, null, null, sqlstate);
    perform app.punch_cards_failed_notice(new.organization_id, null, new.contact_id);
    return null;
  end;
  for v_pay in select x.id, x.source from app.punch_quote_payments(new.organization_id, new.id) x order by 1, 2 loop
    begin
      v_results := jsonb_build_array(app.punch_cards_auto_open(new.organization_id, v_pay.id, null, new.id, v_pay.source));
      perform app.punch_cards_note(new.organization_id, v_pay.id, v_results);
    exception when others then
      raise warning 'quotes_punch_cards: no card was opened for payment % at the acceptance of quote % (%)', v_pay.id, new.id, sqlstate;
      perform app.punch_card_retry_record(new.organization_id, 'open', v_pay.id, null, new.id, null, v_pay.source, sqlstate);
      v_failed := true;
    end;
  end loop;
  -- fourth review, finding 6: one notice per acceptance, however many payments failed
  if v_failed then
    perform app.punch_cards_failed_notice(new.organization_id, null, new.contact_id);
  end if;
  return null;
end;
$$;
revoke all on function app.quotes_punch_cards() from public, anon, authenticated, service_role;

create or replace trigger quotes_zz_punch_cards after update of status on public.quotes
  for each row when (new.status = 'accepted' and old.status is distinct from 'accepted')
  execute function app.quotes_punch_cards();

-- Owner (109) ב: one waiting retry, tried again. The lock order of every opener (owner (106) א): the payment rows first, in id
-- order, then the order's / quote chain's keys, ascending; here nothing is ever waited for: a payment row held elsewhere
-- (nowait) or a key held elsewhere (try lock) raises 55P03, and the row is tried again later. Opening is idempotent
-- (app.punch_cards_auto_open counts the cards a line, or its chain, opened already, and the unique line units refuse a
-- second card), so a retry after a normal opening, or after a card opened by hand on the line, opens nothing more.
-- Answers the cards opened (null for a void_sync row).
create or replace function app.punch_card_retry_one(p_org uuid, p_kind text, p_payment uuid, p_order uuid, p_quote uuid,
                                                    p_source text) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_more uuid[];
  v_key bigint;
  v_pay record;
  v_results jsonb;
  v_opened integer := 0;
begin
  if p_kind = 'quote' then
    select coalesce(array_agg(distinct x.id), '{}') into v_ids from app.punch_quote_payments(p_org, p_quote) x;
  else
    v_ids := array[p_payment];
  end if;
  perform 1 from public.payments pm where pm.organization_id = p_org and pm.id = any (v_ids) order by pm.id for update nowait;
  if p_kind = 'void_sync' then
    perform app.punch_cards_void_sync(p_org, p_payment);
    return null;
  end if;
  for v_key in select distinct k from unnest(app.punch_card_keys(p_org, p_order, p_quote)) k order by k loop
    if not pg_try_advisory_xact_lock(v_key) then
      raise exception 'a punch card key is held elsewhere' using errcode = '55P03';
    end if;
  end loop;
  if p_kind = 'quote' then
    -- a payment that reached the quote meanwhile: locked after the key, never waited for (as app.quotes_punch_cards)
    select coalesce(array_agg(distinct x.id), '{}') into v_more from app.punch_quote_payments(p_org, p_quote) x
     where not (x.id = any (v_ids));
    perform 1 from public.payments pm where pm.organization_id = p_org and pm.id = any (v_more) order by pm.id for update nowait;
    for v_pay in select x.id, x.source from app.punch_quote_payments(p_org, p_quote) x order by 1, 2 loop
      v_results := jsonb_build_array(app.punch_cards_auto_open(p_org, v_pay.id, null, p_quote, v_pay.source));
      perform app.punch_cards_note(p_org, v_pay.id, v_results);
      v_opened := v_opened + coalesce((v_results -> 0 ->> 'opened')::integer, 0);
    end loop;
    return v_opened;
  end if;
  v_results := jsonb_build_array(app.punch_cards_auto_open(p_org, p_payment, p_order, p_quote, p_source));
  perform app.punch_cards_note(p_org, p_payment, v_results);
  return coalesce((v_results -> 0 ->> 'opened')::integer, 0);
end;
$$;
revoke all on function app.punch_card_retry_one(uuid, text, uuid, uuid, uuid, text) from public, anon, authenticated, service_role;

-- Re-review N2 and its follow-ups: the end of one EVENT (the rows one failure wrote share its transaction's created_at and
-- its payment, or for an acceptance its quote) is told once, by the last of its rows to end: nothing while a sibling still
-- waits; then the give-up notice when any row of the event was given up (whether or not another opened a card); else the
-- "ended without a card" notice when this last row ended with nothing opened and no row of the event opened a card. A row
-- closed because the business lost the key (opened null) adds no notice of its own. A void_sync row is an event of its own
-- and only its give-up is told. One read over the event's rows: three keyed arms, by the primary key and by the
-- foreign-key indexes (organization_id, payment_id) and (organization_id, quote_id) (a few rows per payment or quote), so
-- it never scans a table that is not pruned. Never raises.
create or replace function app.punch_card_retry_event_end(p_id uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_waiting boolean;
  v_given_up boolean;
  v_opened boolean;
begin
  select r.* into v_row from app.punch_card_retries r where r.id = p_id;
  if not found then
    return;
  end if;
  if v_row.kind = 'void_sync' then
    if v_row.given_up_at is not null then
      perform app.punch_cards_gave_up_notice(v_row.organization_id, v_row.kind, v_row.payment_id, v_row.quote_id);
    end if;
    return;
  end if;
  select coalesce(bool_or(s.id <> v_row.id and s.done_at is null and s.given_up_at is null), false),
         coalesce(bool_or(s.given_up_at is not null), false),
         coalesce(bool_or(s.opened > 0), false)
    into v_waiting, v_given_up, v_opened
    from (select r.id, r.kind, r.created_at, r.done_at, r.given_up_at, r.opened
            from app.punch_card_retries r where r.id = v_row.id
          union
          select r.id, r.kind, r.created_at, r.done_at, r.given_up_at, r.opened
            from app.punch_card_retries r
           where r.organization_id = v_row.organization_id and r.payment_id = v_row.payment_id and r.created_at = v_row.created_at
          union
          select r.id, r.kind, r.created_at, r.done_at, r.given_up_at, r.opened
            from app.punch_card_retries r
           where r.organization_id = v_row.organization_id and r.quote_id = v_row.quote_id and r.created_at = v_row.created_at) s
   where s.kind <> 'void_sync';
  if v_waiting then
    return;
  end if;
  if v_given_up then
    perform app.punch_cards_gave_up_notice(v_row.organization_id, v_row.kind, v_row.payment_id, v_row.quote_id);
  elsif not v_opened and v_row.done_at is not null and v_row.opened = 0 then
    perform app.punch_cards_retry_empty_notice(v_row.organization_id, v_row.payment_id, v_row.quote_id);
  end if;
exception when others then
  raise warning 'punch_card_retry_event_end: retry % (%)', p_id, sqlstate;
end;
$$;
revoke all on function app.punch_card_retry_event_end(uuid) from public, anon, authenticated, service_role;

-- pg_cron `crm-punch-card-retry` (every 5 minutes). Fair: the due rows of each business in turn, at most p_per_org (20) a
-- business and p_limit (100) a run; each row in its own block. Fifth review, finding 3: a finished row's payment lock and
-- keys are held until the run commits, so the run stays small (a procedure committing per row cannot keep the per-row
-- exception block around its commit, and pg_cron's CALL with COMMIT is not exercised by the local tests). A business that cannot write keeps its row, without a try
-- counted, for an hour. A failed try waits app.punch_card_retry_delay(tries); a row whose next try would fall after
-- app.punch_card_retry_window() (3 days) from its first failure is given up with one notice. Answers the rows done.
create or replace function app.retry_punch_card_openings(p_per_org integer default 20, p_limit integer default 100) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_row record;
  v_state text;
  v_done integer := 0;
  v_opened integer;
  v_timeout text := current_setting('lock_timeout');
begin
  -- a lock the openers take without nowait (a card row in app.punch_cards_void_sync) is never waited for long
  perform set_config('lock_timeout', '2s', true);
  for v_id in
    select r.id
      from (select r.id, r.next_try_at,
                   row_number() over (partition by r.organization_id order by r.next_try_at, r.id) as n
              from app.punch_card_retries r
             where r.done_at is null and r.given_up_at is null and r.next_try_at <= now()) r
     where r.n <= greatest(coalesce(p_per_org, 20), 1)
     order by r.n, r.next_try_at, r.id
     limit greatest(coalesce(p_limit, 100), 1)
  loop
    -- an overlapping run took it, or it ended meanwhile
    select r.* into v_row from app.punch_card_retries r
     where r.id = v_id and r.done_at is null and r.given_up_at is null
     for update skip locked;
    if not found then
      continue;
    end if;
    if not app.org_writable(v_row.organization_id) then
      -- fifth review, finding 2: the window holds whatever the business's state; a card never opens weeks later
      if now() >= v_row.created_at + app.punch_card_retry_window() then
        update app.punch_card_retries set given_up_at = now() where id = v_row.id;
        raise warning 'retry_punch_card_openings: retry % of organization % given up (not writable)', v_row.id, v_row.organization_id;
        perform app.punch_card_retry_event_end(v_row.id);
      else
        update app.punch_card_retries set next_try_at = least(now() + interval '1 hour', v_row.created_at + app.punch_card_retry_window())
         where id = v_row.id;
      end if;
      continue;
    end if;
    -- re-review N3: the business lost the plan key: nothing to open, closed silently (as the openers' key-off path)
    if v_row.kind <> 'void_sync' and not app.org_has_feature(v_row.organization_id, 'punch_cards') then
      update app.punch_card_retries set done_at = now() where id = v_row.id;
      v_done := v_done + 1;
      -- final review, F2: a sibling given up earlier is still told (this row itself adds no notice)
      perform app.punch_card_retry_event_end(v_row.id);
      continue;
    end if;
    begin
      v_opened := app.punch_card_retry_one(v_row.organization_id, v_row.kind, v_row.payment_id, v_row.order_id, v_row.quote_id, v_row.source);
      update app.punch_card_retries set attempts = attempts + 1, done_at = now(), opened = v_opened where id = v_row.id;
      v_done := v_done + 1;
      -- fifth review, finding 4 and re-review N2: owners were told the system would try again; the event's end is told
      -- once (app.punch_card_retry_event_end)
      perform app.punch_card_retry_event_end(v_row.id);
    exception when others then
      v_state := sqlstate;
      if now() + app.punch_card_retry_delay(v_row.attempts + 1) > v_row.created_at + app.punch_card_retry_window() then
        update app.punch_card_retries
           set attempts = attempts + 1, last_sqlstate = v_state, given_up_at = now()
         where id = v_row.id;
        raise warning 'retry_punch_card_openings: retry % of organization % given up (%)', v_row.id, v_row.organization_id, v_state;
        perform app.punch_card_retry_event_end(v_row.id);
      else
        update app.punch_card_retries
           set attempts = attempts + 1, last_sqlstate = v_state, next_try_at = now() + app.punch_card_retry_delay(v_row.attempts + 1)
         where id = v_row.id;
      end if;
    end;
  end loop;
  perform set_config('lock_timeout', v_timeout, true);
  return v_done;
end;
$$;
revoke all on function app.retry_punch_card_openings(integer, integer) from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-punch-card-retry', '*/5 * * * *', 'select app.retry_punch_card_openings();');
  end if;
end;
$$;

-- The automatic entry is history: a person never writes, changes or removes it, and it has no author
create or replace function app.activities_punch_card_entry_guard() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  if tg_op in ('UPDATE', 'DELETE') and coalesce(old.metadata ->> 'kind', '') = 'punch_card_opened' then
    raise exception 'an automatic punch card entry is history' using errcode = '42501', hint = 'activity:punch_card_entry';
  end if;
  if tg_op in ('INSERT', 'UPDATE') and coalesce(new.metadata ->> 'kind', '') = 'punch_card_opened' then
    raise exception 'only the server writes an automatic punch card entry' using errcode = '42501', hint = 'activity:punch_card_entry';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke all on function app.activities_punch_card_entry_guard() from public, anon, authenticated, service_role;

create or replace trigger activities_punch_card_entry_guard before insert or update or delete on public.activities
  for each row execute function app.activities_punch_card_entry_guard();

create or replace function app.activities_punch_card_entry_author() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  new.created_by := null;
  return new;
end;
$$;
revoke all on function app.activities_punch_card_entry_author() from public, anon, authenticated, service_role;

create or replace trigger activities_zz_punch_card_entry_author before insert on public.activities
  for each row when (new.type = 'system' and coalesce(new.metadata ->> 'kind', '') = 'punch_card_opened')
  execute function app.activities_punch_card_entry_author();


notify pgrst, 'reload schema';
