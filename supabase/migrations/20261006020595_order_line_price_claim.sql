-- =============================================================================
-- ORD-01 follow-up (review low on 020585): a person's update that moves a draft line to a price-list price must name the
-- list, as an insert must (hint order_lines:price_list). A line whose list was deleted (on delete set null) keeps its
-- source and the list's name, and stays editable; only the foreign key's own action may clear a line's list by itself
-- (pg_trigger_depth). app.order_lines_check is the body of 020585 with those two changes.
-- Safe to run twice. No drops, no row removal.
-- =============================================================================

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
  -- (fired from the foreign key's own action, a level below the statement; a person's own update of the column alone is
  -- judged below like any other)
  if tg_op = 'UPDATE' and old.price_list_id is not null and new.price_list_id is null and pg_trigger_depth() > 1
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
  elsif tg_op = 'INSERT' or old.price_source <> 'price_list' or (old.price_list_id is not null and new.price_list_id is null) then
    -- a person names the list with a list price, on insert and on update alike (a line whose list was deleted keeps its
    -- source and the list's name below)
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
