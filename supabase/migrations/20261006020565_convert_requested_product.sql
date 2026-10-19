-- =============================================================================
-- Converting a lead puts its requested product on the new deal (RVW-27)
-- =============================================================================
-- RVW-27 (review of 15 October 2026): leads.requested_product_id (LEAD-04, 0177) was left behind on
-- conversion because deals had no product field then; deal lines (DLI-01, 0185) now exist.
--
-- Trigger leads_convert_requested_product (after converted_at is first set, like leads_convert_custom_fields
-- and leads_convert_followers; public.convert_lead itself is unchanged) adds ONE line to the deal the
-- conversion made, when all of these hold, and otherwise adds nothing and says nothing:
-- * the lead has a requested product and the conversion made a deal (not in the recycle bin);
-- * the deal was made in this transaction (created_at = now()) and has no lines yet: a merge that hands a
--   kept lead its duplicate's conversion (merge_records sets converted_at too) passes an older deal, which is
--   left as it is;
-- * the plan has `products`, and the product is still offerable (active, not archived);
-- * the converting person may edit the deal (the deal_lines rule; the deal has the lead's owner and team).
-- The line: the product's name, quantity 1, priced as the app prices a new product line (PL-03,
-- src/features/deal-lines/pricing.ts):
-- * the customer's price list (plan flag `price_lists`): the first that is active and valid today (the
--   business's time zone) of the deal contact's own list, that contact's company's, the deal's company's
--   (pickCustomerList; a company the person cannot read counts as none, as in the app's read); within it the
--   product's tier with the largest min_quantity not above 1 (tierFor): a fixed price with its own VAT mode,
--   or a discount off the product's price, half up (app.price_list_discounted = discountedPrice());
--   no list or no tier: the product's own price;
-- * carried into the deal's VAT mode (a new deal has no lines: the business's prices_include_vat) at the
--   conversion rate of app.deal_lines_sums (0 when the business charges no VAT, else the platform rate of
--   the day, 0 when none) by app.product_line_price (= productPriceFor(), test 200 compares them).
-- The line goes through app.deal_lines_check and deal_lines_billing like any other (one VAT mode, total,
-- billing from the product), and the deal value follows the lines by DLI-03 while it is empty (a typed
-- amount in the conversion form is kept). Any refusal of the insert (P0001, class 23, 42501) is caught, so a
-- conversion never fails because of the line.
-- Only creates functions and a trigger; safe to run twice.

-- price x (10000 - bp) / 10000, half up to the agora (= discountedPrice() in src/features/price-lists/price.ts)
create or replace function app.price_list_discounted(p_price bigint, p_discount_bp integer) returns bigint
language sql immutable
set search_path = ''
as $$
  select floor((p_price::numeric * (10000 - p_discount_bp) * 2 + 10000) / 20000)::bigint
$$;

-- a price typed in one VAT mode, in a line's mode (= productPriceFor() in src/features/products/price.ts)
create or replace function app.product_line_price(p_price bigint, p_includes_vat boolean, p_vat_kind text,
                                                  p_line_includes_vat boolean, p_rate_bp integer) returns bigint
language plpgsql immutable
set search_path = ''
as $$
declare
  v_typed boolean := p_vat_kind = 'taxable' and p_includes_vat;
  v_line  boolean := p_vat_kind = 'taxable' and p_line_includes_vat;
begin
  if v_typed = v_line or p_rate_bp = 0 then
    return p_price;
  end if;
  if v_line then
    return floor((p_price::numeric * (10000 + p_rate_bp) * 2 + 10000) / 20000)::bigint;
  end if;
  return floor((p_price::numeric * 10000 * 2 + (10000 + p_rate_bp)) / (2 * (10000 + p_rate_bp)))::bigint;
end;
$$;

create or replace function app.convert_requested_product() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org          uuid := new.organization_id;
  v_contact      uuid;
  v_company      uuid;
  v_owner        uuid;
  v_team         uuid;
  v_name         text;
  v_price        bigint;
  v_includes     boolean;
  v_kind         text;
  v_contact_list uuid;
  v_contact_co   uuid;
  v_list         uuid;
  v_day          date;
  v_mode         boolean;
  v_rate         integer := 0;
  v_tier_price   bigint;
  v_tier_bp      integer;
  v_tier_incl    boolean;
  v_source       text := 'product';
  v_list_used    uuid;
begin
  if old.converted_at is not null or new.converted_at is null
     or new.requested_product_id is null or new.converted_deal_id is null then
    return null;
  end if;
  if not app.org_has_feature(v_org, 'products') then
    return null;
  end if;

  -- the deal this conversion made, still empty
  select d.contact_id, d.company_id, d.owner_id, d.team_id into v_contact, v_company, v_owner, v_team
    from public.deals d
   where d.organization_id = v_org and d.id = new.converted_deal_id
     and d.deleted_at is null and d.created_at = now();
  if not found
     or exists (select 1 from public.deal_lines l where l.organization_id = v_org and l.deal_id = new.converted_deal_id)
     or (auth.uid() is not null and not app.can_edit_record(v_org, v_owner, v_team)) then
    return null;
  end if;

  select btrim(p.name), p.price_agorot, p.price_includes_vat, p.vat_kind into v_name, v_price, v_includes, v_kind
    from public.products p
   where p.organization_id = v_org and p.id = new.requested_product_id and p.is_active and p.archived_at is null;
  if not found then
    return null;
  end if;
  v_includes := v_kind = 'taxable' and v_includes;
  v_day := (now() at time zone app.intake_zone((select o.timezone from public.organizations o where o.id = v_org)))::date;

  -- PL-03: the customer's price list
  if app.org_has_feature(v_org, 'price_lists') then
    if v_contact is not null then
      select c.price_list_id, c.company_id into v_contact_list, v_contact_co
        from public.contacts c
       where c.organization_id = v_org and c.id = v_contact
         and (auth.uid() is null or app.can_read_record(c.organization_id, c.owner_id, c.team_id));
    end if;
    select l.id into v_list
      from (values (1, v_contact_list),
                   (2, (select co.price_list_id from public.companies co
                         where co.organization_id = v_org and co.id = v_contact_co
                           and (auth.uid() is null or app.can_read_record(co.organization_id, co.owner_id, co.team_id)))),
                   (3, (select co.price_list_id from public.companies co
                         where co.organization_id = v_org and co.id = v_company
                           and (auth.uid() is null or app.can_read_record(co.organization_id, co.owner_id, co.team_id)))))
           as o(n, list_id)
      join public.price_lists l on l.organization_id = v_org and l.id = o.list_id
     where l.is_active
       and (l.valid_from is null or l.valid_from <= v_day)
       and (l.valid_to is null or l.valid_to >= v_day)
     order by o.n
     limit 1;
    if v_list is not null then
      select t.price_agorot, t.discount_bp, t.price_includes_vat into v_tier_price, v_tier_bp, v_tier_incl
        from public.price_list_lines t
       where t.organization_id = v_org and t.price_list_id = v_list and t.product_id = new.requested_product_id
         and t.min_quantity <= 1
       order by t.min_quantity desc, t.id
       limit 1;
      if found then
        if v_tier_price is not null then
          v_price := v_tier_price;
          v_includes := v_kind = 'taxable' and v_tier_incl;
          v_source := 'price_list';
          v_list_used := v_list;
        elsif v_tier_bp is not null then
          v_price := app.price_list_discounted(v_price, v_tier_bp);
          v_source := 'price_list';
          v_list_used := v_list;
        end if;
      end if;
    end if;
  end if;

  -- the deal's VAT mode (no lines yet: the business's setting) and the conversion rate of app.deal_lines_sums
  v_mode := coalesce((select s.prices_include_vat from public.org_document_settings s where s.organization_id = v_org), false);
  if app.org_charges_vat(v_org) is distinct from false then
    v_rate := coalesce(app.vat_rate_at(v_day), 0);
  end if;
  v_price := app.product_line_price(v_price, v_includes, v_kind, v_mode, v_rate);

  begin
    insert into public.deal_lines (organization_id, deal_id, position, product_id, description, quantity,
                                   unit_price_agorot, price_includes_vat, price_source, price_list_id)
    values (v_org, new.converted_deal_id, 1, new.requested_product_id, left(v_name, 1000), 1,
            v_price, v_mode, v_source, v_list_used);
  exception when raise_exception or integrity_constraint_violation or insufficient_privilege then
    null;
  end;
  return null;
end;
$$;

revoke all on function app.price_list_discounted(bigint, integer) from public, anon, authenticated, service_role;
revoke all on function app.product_line_price(bigint, boolean, text, boolean, integer) from public, anon, authenticated, service_role;
revoke all on function app.convert_requested_product() from public, anon, authenticated, service_role;

create or replace trigger leads_convert_requested_product after update of converted_at on public.leads
  for each row
  when (old.converted_at is null and new.converted_at is not null)
  execute function app.convert_requested_product();
