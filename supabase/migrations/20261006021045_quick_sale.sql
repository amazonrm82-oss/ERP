-- =============================================================================
-- GAP-08: quick sale at the counter (wave 2; spec: "לקוח, פריט, אמצעי תשלום, סיום. נרשם תשלום, ומופק או נרשם מסמך לפי
-- מצב העבודה (פרק 6.2)"). Work mode today is 6.2 (א): no invoicing provider, so a document issued elsewhere is RECORDED
-- (DOC-01), never issued here.
-- =============================================================================
-- public.quick_sale(org, sale) is SECURITY INVOKER on purpose: every row goes in through the existing tables with the
-- caller's session, so their RLS policies, column grants and triggers judge it exactly as on the cards (no rule is
-- bypassed). One call = one transaction: any refusal undoes all of it. It makes, in order:
--   1. the customer: an existing live contact the caller reads (`contact_id`), or a new contact (`new_contact`
--      {first_name, last_name?, phone}; owner by the default-owner trigger, as the contact form);
--   2. a deal on the business's default pipeline (else its first live one), on the contact, made in the pipeline's first
--      open stage and then moved to its first won stage (position, id) in this same call, so the stage move is an
--      ordinary update: the timeline, closed_at and the `deal_won` automations follow as for any won deal (a pipeline with
--      no open stage gets the deal straight in the won stage). Revenue reports, goals and RPT-01 count it. Its name comes
--      from the screen (the business's word for a deal, "מכירה מהירה" and the date; never the customer's name, so a privacy
--      erasure has nothing to rename), else "מכירה מהירה, <date>";
--   3. its product lines (1..50 offerable products, one-time billing only: a counter sale is one charge, so a recurring
--      product is refused, hint quick_sale:recurring). A payment and a document rely on these prices, so each line's unit
--      price is derived here again by PL-03 (CLAUDE.md DLI-01: verify before documents rely on it): the customer's price
--      list (flag `price_lists`; the contact's own list, else its company's, each read with the caller's rights; the first
--      that is active and valid today), the product's tier with the largest min_quantity not above the quantity (a fixed
--      price in the list's VAT mode, or a discount off the product's price, app.price_list_discounted), else the product's
--      price, carried into the business's VAT mode at the conversion rate (app.product_line_price, as
--      app.convert_requested_product does). A sent price, source or list that differs is refused (hint quick_sale:price).
--      deal_lines_check holds the rest (VAT mode, flags, offerable product, the line total). The deal value follows the
--      lines (DLI-03);
--   4. the payment (PAY-01/04/05: method, credit instalments, reference; or a series of cheques, each in hand or cleared,
--      each its own payment, adding up exactly to the total), of the
--      lines' total WITH VAT by app.document_totals at the day's document rate (app.org_document_vat_rate; unknown VAT
--      status = hint quick_sale:vat_unknown). The screen sends the total it showed; a different server total is refused
--      (quick_sale:total_changed), so nobody records an amount they did not see;
--   5. optionally a recorded external document (DOC-01): tax_invoice_receipt or receipt, the typed number, today, the same
--      amount, on the deal and the contact. PAY-02 allocates only to a tax invoice or a proforma, so neither type takes an
--      allocation (a tax invoice-receipt is "paid on issue" in money_allocation_state).
-- Rights and flags are checked first, in this order, so an outsider learns nothing about the plan: may record payments
-- in a writable business (else 42501), flag `payments`, flag `products`; with a document also may record documents
-- (42501) and flag `documents`. No new plan key (lead's choice until the owner answers).
-- "Today" is the business's day (organizations.timezone).
-- PKG-01 (wave 3, punch cards) plugs in at step 3/4: a card product sold here opens its card once the payment exists.
-- Returns {deal_id, contact_id, payment_id (the first), payment_ids, document_id, total_agorot}.
-- The owner's answers (26 October 2026): no plan key of its own; the sales process is the business's setting
-- org_document_settings.quick_sale_pipeline_id (owners/admins, column grants; composite FK set null; null, hidden or deleted
-- = the default one); recurring products refused; tax invoice-receipt or receipt only; cash is confirmed, every other method
-- recorded (a cheque follows PAY-04: in hand = recorded, cleared = confirmed); a series of 1..36 cheques, each its own
-- payment, whose amounts add up exactly to the total (hint quick_sale:cheques_total); a new customer goes through the app's
-- duplicate check first (DQL-02); a held customer is warned about on the screen only (COL-05).
-- Adds a column, an index and a function; safe to run twice. No drops, no row removal.

-- the business's sales process for quick sales (null = the default one)
alter table public.org_document_settings add column if not exists quick_sale_pipeline_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'org_document_settings_quick_sale_pipeline_fk') then
    alter table public.org_document_settings add constraint org_document_settings_quick_sale_pipeline_fk
      foreign key (organization_id, quick_sale_pipeline_id) references public.pipelines (organization_id, id)
      on delete set null (quick_sale_pipeline_id);
  end if;
end;
$$;
create index if not exists org_document_settings_quick_sale_pipeline_idx
  on public.org_document_settings (organization_id, quick_sale_pipeline_id);
grant insert (quick_sale_pipeline_id), update (quick_sale_pipeline_id) on public.org_document_settings to authenticated;

create or replace function public.quick_sale(p_org uuid, p_sale jsonb) returns jsonb
language plpgsql volatile security invoker
set search_path = ''
as $$
declare
  c_max_lines constant integer := 50;
  v_lines    jsonb;
  v_pay      jsonb;
  v_doc      jsonb;
  v_new      jsonb;
  v_contact  uuid;
  v_zone     text;
  v_day      date;
  v_rate     integer;
  v_pipeline uuid;
  v_stage    uuid;
  v_deal     uuid;
  v_line     jsonb;
  v_pos      integer := 0;
  v_product  record;
  v_qty      numeric;
  v_price    bigint;
  v_source   text;
  v_given_list uuid;
  v_items    jsonb;
  v_mode     boolean;
  v_total    bigint;
  v_expected bigint;
  v_method   text;
  v_cheque   jsonb;
  v_payment  uuid;
  v_doc_type text;
  v_number   text;
  v_document uuid;
  v_open     uuid;
  v_conv     integer;
  v_list     uuid;
  v_tier     record;
  v_exp_price  bigint;
  v_exp_incl   boolean;
  v_exp_source text;
  v_exp_list   uuid;
  v_deal_name  text;
  v_cheques    jsonb;
  v_sum        numeric;
  v_payments   uuid[] := '{}';
begin
  if p_org is null or p_sale is null or jsonb_typeof(p_sale) <> 'object' then
    raise exception 'invalid quick sale' using errcode = '22023', hint = 'quick_sale:invalid';
  end if;
  v_lines := p_sale -> 'lines';
  v_pay := p_sale -> 'payment';
  v_doc := case when jsonb_typeof(p_sale -> 'document') = 'object' then p_sale -> 'document' end;
  v_new := case when jsonb_typeof(p_sale -> 'new_contact') = 'object' then p_sale -> 'new_contact' end;

  -- rights first: a stranger, a viewer or a person without the right to record payments learns nothing more
  if auth.uid() is null or not app.can_record_payments(p_org) or not app.org_writable(p_org)
     or (v_doc is not null and not app.can_record_documents(p_org)) then
    raise exception 'not permitted' using errcode = '42501', hint = 'quick_sale:cannot';
  end if;
  if not app.org_has_feature(p_org, 'payments') then
    raise exception 'payments are not in this plan' using errcode = 'P0001', hint = 'feature:payments';
  end if;
  if not app.org_has_feature(p_org, 'products') then
    raise exception 'products are not in this plan' using errcode = 'P0001', hint = 'feature:products';
  end if;
  if v_doc is not null and not app.org_has_feature(p_org, 'documents') then
    raise exception 'documents are not in this plan' using errcode = 'P0001', hint = 'feature:documents';
  end if;

  -- the shape
  if jsonb_typeof(v_lines) is distinct from 'array' or jsonb_array_length(v_lines) not between 1 and c_max_lines
     or jsonb_typeof(v_pay) is distinct from 'object'
     or (nullif(p_sale ->> 'contact_id', '') is null) = (v_new is null)
     or jsonb_typeof(p_sale -> 'expected_total_agorot') is distinct from 'number' then
    raise exception 'invalid quick sale' using errcode = '22023', hint = 'quick_sale:invalid';
  end if;
  v_expected := (p_sale ->> 'expected_total_agorot')::bigint;
  v_method := v_pay ->> 'method';
  if v_method = 'cheque' then
    -- a series of 1..36 cheques, each in hand or cleared, each with a whole positive amount
    v_cheques := v_pay -> 'cheques';
    if jsonb_typeof(v_cheques) is distinct from 'array' or jsonb_array_length(v_cheques) not between 1 and 36
       or exists (select 1 from jsonb_array_elements(v_cheques) c(x)
                   where jsonb_typeof(c.x) is distinct from 'object'
                      or coalesce(c.x ->> 'cheque_status', '') not in ('in_hand', 'cleared')
                      or jsonb_typeof(c.x -> 'amount_agorot') is distinct from 'number'
                      or (c.x ->> 'amount_agorot')::numeric < 1
                      or (c.x ->> 'amount_agorot')::numeric <> trunc((c.x ->> 'amount_agorot')::numeric)) then
      raise exception 'invalid quick sale cheques' using errcode = '22023', hint = 'quick_sale:invalid';
    end if;
  end if;
  v_deal_name := nullif(btrim(coalesce(p_sale ->> 'deal_name', '')), '');
  if v_deal_name is not null and char_length(v_deal_name) > 200 then
    raise exception 'invalid quick sale deal name' using errcode = '22023', hint = 'quick_sale:invalid';
  end if;
  if v_doc is not null then
    v_doc_type := v_doc ->> 'doc_type';
    v_number := btrim(coalesce(v_doc ->> 'number', ''));
    if v_doc_type is null or v_doc_type not in ('tax_invoice_receipt', 'receipt') or v_number = '' then
      raise exception 'invalid quick sale document' using errcode = '22023', hint = 'quick_sale:invalid';
    end if;
  end if;

  -- the business's day and the document rate of that day (null = the VAT status is not set yet)
  select o.timezone into v_zone from public.organizations o where o.id = p_org;
  v_day := (now() at time zone coalesce(nullif(v_zone, ''), 'Asia/Jerusalem'))::date;
  v_rate := app.org_document_vat_rate(p_org, v_day);
  if v_rate is null then
    raise exception 'the business has not set its VAT status' using errcode = 'P0001', hint = 'quick_sale:vat_unknown';
  end if;

  -- the business's quick-sale process while it is live, else the default one, else the first live one; its first won stage
  select p.id into v_pipeline
    from public.pipelines p
   where p.organization_id = p_org and p.deleted_at is null
   order by (p.id = (select s.quick_sale_pipeline_id from public.org_document_settings s where s.organization_id = p_org))
            is true desc,
            p.is_default desc, p.position, p.id
   limit 1;
  if v_pipeline is null then
    raise exception 'no sales process' using errcode = 'P0001', hint = 'quick_sale:no_pipeline';
  end if;
  select s.id into v_stage
    from public.stages s
   where s.organization_id = p_org and s.pipeline_id = v_pipeline and s.kind = 'won'
   order by s.position, s.id
   limit 1;
  if v_stage is null then
    raise exception 'the sales process has no won stage' using errcode = 'P0001', hint = 'quick_sale:no_won_stage';
  end if;
  select s.id into v_open
    from public.stages s
   where s.organization_id = p_org and s.pipeline_id = v_pipeline and s.kind = 'open'
   order by s.position, s.id
   limit 1;

  -- 1. the customer
  if v_new is null then
    select c.id into v_contact
      from public.contacts c
     where c.organization_id = p_org and c.id = (p_sale ->> 'contact_id')::uuid and c.deleted_at is null;
    if v_contact is null then
      raise exception 'the customer was not found' using errcode = 'P0001', hint = 'quick_sale:contact';
    end if;
    -- PL-03: the customer's price list, read with the caller's rights (an unreadable company counts as none)
    if app.org_has_feature(p_org, 'price_lists') then
      select l.id into v_list
        from public.contacts c
        left join public.companies co on co.organization_id = c.organization_id and co.id = c.company_id
        cross join lateral (values (1, c.price_list_id), (2, co.price_list_id)) as o(n, list_id)
        join public.price_lists l on l.organization_id = p_org and l.id = o.list_id
       where c.organization_id = p_org and c.id = v_contact
         and l.is_active
         and (l.valid_from is null or l.valid_from <= v_day)
         and (l.valid_to is null or l.valid_to >= v_day)
       order by o.n
       limit 1;
    end if;
  else
    if btrim(coalesce(v_new ->> 'first_name', '')) = '' then
      raise exception 'a new customer needs a name' using errcode = '22023', hint = 'quick_sale:invalid';
    end if;
    insert into public.contacts (organization_id, first_name, last_name, phone)
    values (p_org, btrim(v_new ->> 'first_name'), nullif(btrim(coalesce(v_new ->> 'last_name', '')), ''),
            nullif(btrim(coalesce(v_new ->> 'phone', '')), ''))
    returning id into v_contact;
  end if;

  -- 2. the won deal
  insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id)
  values (p_org, coalesce(v_deal_name, 'מכירה מהירה, ' || to_char(v_day, 'DD.MM.YYYY')), v_pipeline,
          coalesce(v_open, v_stage), v_contact)
  returning id into v_deal;

  -- the business's VAT mode for a deal with no lines yet, and the rate that carries a price between the modes
  -- (= conversionRateBp(): the day's document rate; the status is known here)
  v_mode := coalesce((select s.prices_include_vat from public.org_document_settings s where s.organization_id = p_org), false);
  v_conv := case when app.org_charges_vat(p_org) is distinct from false then coalesce(app.vat_rate_at(v_day), 0) else 0 end;

  -- 3. the lines (PKG-01 seam: a punch-card product is recognised here once wave 3 adds it)
  for v_line in select x from jsonb_array_elements(v_lines) as t(x) loop
    if jsonb_typeof(v_line) is distinct from 'object' or jsonb_typeof(v_line -> 'quantity') is distinct from 'number'
       or jsonb_typeof(v_line -> 'unit_price_agorot') is distinct from 'number' then
      raise exception 'invalid quick sale line' using errcode = '22023', hint = 'quick_sale:invalid';
    end if;
    v_pos := v_pos + 1;
    v_qty := (v_line ->> 'quantity')::numeric;
    v_price := (v_line ->> 'unit_price_agorot')::bigint;
    v_source := coalesce(v_line ->> 'price_source', 'product');
    v_given_list := nullif(v_line ->> 'price_list_id', '')::uuid;
    select p.id, btrim(p.name) as name, p.billing, p.is_active, p.archived_at, p.price_agorot, p.price_includes_vat,
           p.vat_kind into v_product
      from public.products p
     where p.organization_id = p_org and p.id = nullif(v_line ->> 'product_id', '')::uuid;
    if v_product.id is null or not v_product.is_active or v_product.archived_at is not null then
      raise exception 'the product cannot be sold' using errcode = 'P0001', hint = 'quick_sale:product';
    end if;
    if v_product.billing is distinct from 'one_time' then
      raise exception 'a quick sale is a one-time charge' using errcode = 'P0001', hint = 'quick_sale:recurring';
    end if;
    -- PL-03 again, on the server (= pulledPrice(): unitPriceFor, then productPriceFor into the deal's mode)
    v_exp_price := v_product.price_agorot;
    v_exp_incl := v_product.vat_kind = 'taxable' and v_product.price_includes_vat;
    v_exp_source := 'product';
    v_exp_list := null;
    if v_list is not null then
      select t.price_agorot, t.discount_bp, t.price_includes_vat into v_tier
        from public.price_list_lines t
       where t.organization_id = p_org and t.price_list_id = v_list and t.product_id = v_product.id
         and t.min_quantity <= v_qty
       order by t.min_quantity desc, t.id
       limit 1;
      if found then
        if v_tier.price_agorot is not null then
          v_exp_price := v_tier.price_agorot;
          v_exp_incl := v_product.vat_kind = 'taxable' and v_tier.price_includes_vat;
          v_exp_source := 'price_list';
          v_exp_list := v_list;
        elsif v_tier.discount_bp is not null then
          -- = app.price_list_discounted / discountedPrice(): half up to the agora
          v_exp_price := floor((v_product.price_agorot::numeric * (10000 - v_tier.discount_bp) * 2 + 10000) / 20000)::bigint;
          v_exp_source := 'price_list';
          v_exp_list := v_list;
        end if;
      end if;
    end if;
    -- = app.product_line_price / productPriceFor(): carried into the deal's mode, half up (those two helpers are callable
    -- by no role, test 200; keep this copy in step, test 247 compares them)
    v_exp_incl := v_product.vat_kind = 'taxable' and v_exp_incl;
    if v_exp_incl <> (v_product.vat_kind = 'taxable' and v_mode) and v_conv <> 0 then
      if v_mode then
        v_exp_price := floor((v_exp_price::numeric * (10000 + v_conv) * 2 + 10000) / 20000)::bigint;
      else
        v_exp_price := floor((v_exp_price::numeric * 10000 * 2 + (10000 + v_conv)) / (2 * (10000 + v_conv)))::bigint;
      end if;
    end if;
    if v_price is distinct from v_exp_price or v_source is distinct from v_exp_source
       or v_given_list is distinct from v_exp_list then
      raise exception 'the price is not the customer''s price' using errcode = 'P0001', hint = 'quick_sale:price';
    end if;
    insert into public.deal_lines (organization_id, deal_id, position, product_id, description, quantity,
                                   unit_price_agorot, price_source, price_list_id)
    values (p_org, v_deal, v_pos, v_product.id, left(v_product.name, 1000), v_qty, v_exp_price, v_exp_source, v_exp_list);
  end loop;

  -- won: an ordinary stage move, so the timeline, closed_at and the deal_won automations follow
  if v_open is not null then
    update public.deals set stage_id = v_stage
     where organization_id = p_org and id = v_deal;
  end if;

  -- the amount the customer pays: the lines' total with VAT, by the one totals rule (TAX-05)
  select jsonb_agg(jsonb_build_object('quantity', l.quantity, 'unit_price_agorot', l.unit_price_agorot,
                                      'discount_bp', l.discount_bp, 'discount_agorot', l.discount_agorot,
                                      'vat_exempt', l.vat_exempt) order by l.position, l.id),
         bool_or(l.price_includes_vat)
    into v_items, v_mode
    from public.deal_lines l
   where l.organization_id = p_org and l.deal_id = v_deal;
  v_total := (app.document_totals(v_items, v_rate, coalesce(v_mode, false)) ->> 'total_agorot')::bigint;
  if v_total is null or v_total < 1 then
    raise exception 'a sale of nothing' using errcode = 'P0001', hint = 'quick_sale:zero';
  end if;
  if v_total <> v_expected then
    raise exception 'the total changed' using errcode = 'P0001', hint = 'quick_sale:total_changed';
  end if;

  -- 4. the payment. Cash is confirmed, every other method recorded (owner, 26 October 2026). Cheques: a series, each its own
  -- payment, the amounts adding up exactly to the total; the cheque trigger sets each payment's status from its cheque's
  if v_method = 'cheque' then
    select sum((c.x ->> 'amount_agorot')::numeric) into v_sum from jsonb_array_elements(v_cheques) c(x);
    if v_sum <> v_total then
      raise exception 'the cheques do not add up to the total' using errcode = 'P0001', hint = 'quick_sale:cheques_total';
    end if;
    for v_cheque in select c.x from jsonb_array_elements(v_cheques) with ordinality c(x, n) order by c.n loop
      insert into public.payments (organization_id, deal_id, contact_id, amount_agorot, paid_on, method, reference,
                                   cheque_number, cheque_bank, cheque_bank_name, cheque_branch, cheque_due_date, cheque_status)
      values (p_org, v_deal, v_contact, (v_cheque ->> 'amount_agorot')::bigint, v_day, 'cheque',
              nullif(btrim(coalesce(v_pay ->> 'reference', '')), ''),
              v_cheque ->> 'cheque_number', v_cheque ->> 'cheque_bank', v_cheque ->> 'cheque_bank_name',
              v_cheque ->> 'cheque_branch', nullif(v_cheque ->> 'cheque_due_date', '')::date, v_cheque ->> 'cheque_status')
      returning id into v_payment;
      v_payments := v_payments || v_payment;
    end loop;
  else
    insert into public.payments (organization_id, deal_id, contact_id, amount_agorot, paid_on, method, installments,
                                 reference, status)
    values (p_org, v_deal, v_contact, v_total, v_day, v_method,
            case when v_method = 'credit' then coalesce(nullif(v_pay ->> 'installments', '')::smallint, 1) end,
            nullif(btrim(coalesce(v_pay ->> 'reference', '')), ''),
            case when v_method = 'cash' then 'confirmed' else 'recorded' end)
    returning id into v_payment;
    v_payments := array[v_payment];
  end if;

  -- 5. the recorded document (no allocation: PAY-02 takes only a tax invoice or a proforma)
  if v_doc is not null then
    insert into public.accounting_documents (organization_id, deal_id, contact_id, doc_type, number, doc_date, amount_agorot)
    values (p_org, v_deal, v_contact, v_doc_type, v_number, v_day, v_total)
    returning id into v_document;
  end if;

  return jsonb_build_object('deal_id', v_deal, 'contact_id', v_contact, 'payment_id', v_payments[1],
                            'payment_ids', to_jsonb(v_payments), 'document_id', v_document, 'total_agorot', v_total);
end;
$$;

revoke all on function public.quick_sale(uuid, jsonb) from public, anon;
grant execute on function public.quick_sale(uuid, jsonb) to authenticated;
