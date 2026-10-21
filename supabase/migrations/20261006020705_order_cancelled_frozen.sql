-- RVW-47 (weekly review of 21 October 2026, low): a cancelled order still let a person change its delivery date, shipping
-- address, notes and delivery contact; the contract of 020570 says those are "editable while the order is not cancelled".
-- app.orders_check (the body of 20261006020700) now refuses a person any change to a cancelled order (hint order:cancelled);
-- a touch with nothing changed still goes, and server writes (a purge's detach, a merge, an FK set-null, erasure) are not
-- persons and pass as before.
-- Every statement is safe to run twice. No drops, no row removal.

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
  -- RVW-41: a foreign key's own "on delete set null" (the delivery contact, the quote or the original order was purged) is a
  -- server write, like the sibling checks (order_lines_check, accounting_documents_check, payments_check): it runs one
  -- trigger level down and changes nothing but those columns, to null
  if v_person and tg_op = 'UPDATE' and pg_trigger_depth() > 1
     and (to_jsonb(new) - 'delivery_contact_id' - 'quote_id' - 'original_order_id')
       = (to_jsonb(old) - 'delivery_contact_id' - 'quote_id' - 'original_order_id')
     and (new.delivery_contact_id is null or new.delivery_contact_id is not distinct from old.delivery_contact_id)
     and (new.quote_id is null or new.quote_id is not distinct from old.quote_id)
     and (new.original_order_id is null or new.original_order_id is not distinct from old.original_order_id) then
    v_person := false;
  end if;

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
      -- RVW-47: nor does a person change anything else in it (delivery date, address, notes, delivery contact); touching it
      -- (no change) still goes. The amounts are put back below for every numbered order, so they are left out here.
      if old.status = 'cancelled'
         and (to_jsonb(new) - 'updated_at' - 'vat_rate_bp' - 'subtotal_agorot' - 'discount_total_agorot' - 'net_total_agorot'
                           - 'vat_agorot' - 'total_agorot')
             is distinct from
             (to_jsonb(old) - 'updated_at' - 'vat_rate_bp' - 'subtotal_agorot' - 'discount_total_agorot' - 'net_total_agorot'
                           - 'vat_agorot' - 'total_agorot') then
        raise exception 'a cancelled order is not changed' using errcode = 'P0001', hint = 'order:cancelled';
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

  -- a person's order names a customer (owner (5)) when it is made and whenever a person changes its customer. RVW-41: an order
  -- whose contact was purged keeps its deal (app.orders_detach), and a deal is customer enough for it to stay workable
  if v_person and new.contact_id is null and new.company_id is null
     and (tg_op = 'INSERT' or new.contact_id is distinct from old.contact_id or new.company_id is distinct from old.company_id) then
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
