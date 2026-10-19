-- =============================================================================
-- Orders, part two (lane follow-up of ORD-01, 19 October 2026): product lines on a manual draft priced by PL-03 like
-- deal lines, and order_from_deal's line name.
-- =============================================================================
-- * order_lines.price_list_id: the customer's price list that set a line's price (composite FK, on delete set null of the
--   column; the line keeps the list's name). Only a line priced from a list names one (order_lines_list_source).
-- * app.order_lines_check (the body of 020570 plus the price list block of app.quote_lines_check): a person's product line
--   may claim its price source (product | price_list | manual, as on deal lines: a claim, verified on the server before a
--   document relies on it); a price list needs the `price_lists` flag and its name always comes from the list. A free line
--   is 'manual'. Server copies keep a list name they were given.
-- * public.order_from_deal (the body of 020570): a deal line whose description is blank after trimming no longer fails the
--   name check; the name is the trimmed description, else the product's name, else "שורה". The line's price list comes along.
-- Every statement is safe to run twice. No drops, no row removal.

alter table public.order_lines add column if not exists price_list_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'order_lines_price_list_fk' and conrelid = 'public.order_lines'::regclass) then
    alter table public.order_lines add constraint order_lines_price_list_fk foreign key (organization_id, price_list_id)
      references public.price_lists (organization_id, id) on delete set null (price_list_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'order_lines_list_source' and conrelid = 'public.order_lines'::regclass) then
    alter table public.order_lines add constraint order_lines_list_source check (price_source = 'price_list' or price_list_id is null);
  end if;
end;
$$;

create index if not exists order_lines_price_list_idx on public.order_lines (organization_id, price_list_id);

grant insert (price_source, price_list_id) on public.order_lines to authenticated;
grant update (unit_price_agorot, price_source, price_list_id) on public.order_lines to authenticated;

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
  -- a price list was deleted (on delete set null of price_list_id): the line keeps its price and the list's name, whatever
  -- the order's state; nothing else changes
  if tg_op = 'UPDATE' and old.price_list_id is not null and new.price_list_id is null
     and (to_jsonb(new) - 'price_list_id' - 'updated_at') = (to_jsonb(old) - 'price_list_id' - 'updated_at') then
    return new;
  end if;
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
      -- a free line is priced by hand; a product line's price source is the person's claim (PL-03, as on deal lines:
      -- the product's price, a price list's, or typed); a list's name always comes from the list itself below
      if new.product_id is null then
        new.price_source := 'manual';
      end if;
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
    if old.product_id is null then
      new.price_source := 'manual';
    end if;
    if old.product_id is not null then
      new.vat_exempt := old.vat_exempt;
      new.billing := old.billing;
    end if;
  end if;

  -- the price list that set the price (PL-03); its name is kept with the line
  if new.price_source <> 'price_list' then
    if new.price_list_id is not null and v_person then
      raise exception 'only a price from a price list names a list' using errcode = 'P0001', hint = 'order_lines:price_list';
    end if;
    new.price_list_id := null;
    new.price_list_name := null;
  elsif new.price_list_id is not null
        and (tg_op = 'INSERT' or new.price_list_id is distinct from old.price_list_id) then
    if v_person and not app.org_has_feature(new.organization_id, 'price_lists') then
      raise exception 'price lists are not in this plan' using errcode = 'P0001', hint = 'feature:price_lists';
    end if;
    select l.name into new.price_list_name from public.price_lists l
     where l.organization_id = new.organization_id and l.id = new.price_list_id;
  elsif not v_person then
    -- a server copy (from a quote or a deal) keeps the list's name it was given, even when the list is gone
    null;
  elsif tg_op = 'INSERT' then
    raise exception 'a price from a price list names the list' using errcode = 'P0001', hint = 'order_lines:price_list';
  else
    -- unchanged, or its list was removed (on delete set null): the line keeps the name it was priced by
    new.price_list_name := old.price_list_name;
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
                                  discount_bp, discount_agorot, vat_exempt, billing, price_source, price_list_id,
                                  price_list_name, currency, unit_name)
  select l.organization_id, v_new, l.position, 'item', l.product_id,
         -- the deal line's description is the order line's name: trimmed first (a name holds 1..300 characters
         -- that are not all blank), else the product's name, else a neutral one
         coalesce(nullif(btrim(left(btrim(l.description), 300)), ''),
                  nullif(btrim(left((select p.name from public.products p
                                      where p.organization_id = l.organization_id and p.id = l.product_id), 300)), ''),
                  'שורה'),
         l.quantity, l.unit_price_agorot,
         l.discount_bp, l.discount_agorot, l.vat_exempt, coalesce(l.billing, 'one_time'), l.price_source,
         case when l.price_source = 'price_list' then l.price_list_id end, l.price_list_name,
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
