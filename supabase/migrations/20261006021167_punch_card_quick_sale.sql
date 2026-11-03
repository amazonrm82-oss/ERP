-- =============================================================================
-- PKG-01: the quick sale's own deal, marked by the server (owner (107) ב), and the cards it sold (fourth review, finding 4)
-- =============================================================================
-- * deals.quick_sale_at (server only): stamped by trigger deals_quick_sale_mark on the one deal public.quick_sale creates:
--   quick_sale generates the deal's id first, names it in the transaction setting app.quick_sale_deal, inserts the deal with
--   that id and clears the setting before it returns. The trigger is the only writer, for every writer: on insert the
--   column is now() only when the setting equals the new row's id, else null; on update it keeps the old value. deals has
--   table-wide client grants, so the column is not protected by grants: the trigger is what keeps it server-only (a person's
--   insert or update, an import, sample data, a merge, a duplicate or follow-up deal can never set or copy it). A client
--   cannot set an app.* setting through the API (only public functions are exposed, one transaction per request).
-- * app.quick_sale_lines (no grants): every line quick_sale inserts, recorded by trigger deal_lines_quick_sale while the
--   setting names the line's deal: its position, whether it is a punch card, its whole units (at most 20) and its with-VAT
--   amount at the sale (the weight its share of the sale's charge is split by). A line added after the sale is not there.
-- * public.quick_sale: the body of 021045 with only the id-first insert, the setting and its clearing (comments).
-- * public.punch_card_open_for_sale (moved here from punch_cards): only a deal carrying quick_sale_at; it opens only the
--   punch card units the sale recorded, each at its share of what the sale charged, once (punch_cards_deal_line_unit_idx).
-- Safe to run twice. No drop statement, no delete.

alter table public.deals add column if not exists quick_sale_at timestamptz;

create or replace function app.deals_quick_sale_mark() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.quick_sale_at := case when nullif(current_setting('app.quick_sale_deal', true), '') = new.id::text then now() end;
  else
    new.quick_sale_at := old.quick_sale_at;
  end if;
  return new;
end;
$$;
revoke all on function app.deals_quick_sale_mark() from public, anon, authenticated, service_role;

create or replace trigger deals_quick_sale_mark before insert or update on public.deals
  for each row execute function app.deals_quick_sale_mark();

create table if not exists app.quick_sale_lines (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  deal_id         uuid not null,
  deal_line_id    uuid not null,
  position        integer not null,
  is_punch        boolean not null,
  units           integer not null check (units between 0 and 20),
  weight_agorot   bigint not null check (weight_agorot >= 0),
  created_at      timestamptz not null default now(),
  primary key (organization_id, deal_line_id),
  foreign key (organization_id, deal_line_id) references public.deal_lines (organization_id, id) on delete cascade
);
create index if not exists quick_sale_lines_deal_idx on app.quick_sale_lines (organization_id, deal_id);
alter table app.quick_sale_lines enable row level security;
revoke all on app.quick_sale_lines from public, anon, authenticated, service_role;

create or replace function app.deal_lines_quick_sale() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_punch boolean;
begin
  if nullif(current_setting('app.quick_sale_deal', true), '') is distinct from new.deal_id::text then
    return null;
  end if;
  v_punch := exists (select 1 from public.products p
                      where p.organization_id = new.organization_id and p.id = new.product_id and p.kind = 'punch_card');
  insert into app.quick_sale_lines (organization_id, deal_id, deal_line_id, position, is_punch, units, weight_agorot)
  values (new.organization_id, new.deal_id, new.id, new.position, v_punch,
          case when v_punch then least(20, greatest(0, floor(new.quantity)::integer)) else 0 end,
          coalesce(app.punch_with_vat(new.total_agorot, new.price_includes_vat, new.vat_exempt,
                                      app.org_document_vat_rate(new.organization_id, app.punch_card_today(new.organization_id))), 0))
  on conflict do nothing;
  return null;
end;
$$;
revoke all on function app.deal_lines_quick_sale() from public, anon, authenticated, service_role;

create or replace trigger deal_lines_quick_sale after insert on public.deal_lines
  for each row execute function app.deal_lines_quick_sale();

-- The quick sale (the body of 021045; only the id-first insert and the setting are new)
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
  -- PKG-01 (owner (107) ב): the deal's id first, named in a transaction setting, so the trigger deals_quick_sale_mark stamps
  -- the server-only quick_sale_at on this deal alone, and deal_lines_quick_sale records the lines this sale sells
  v_deal := gen_random_uuid();
  perform set_config('app.quick_sale_deal', v_deal::text, true);
  insert into public.deals (id, organization_id, name, pipeline_id, stage_id, contact_id)
  values (v_deal, p_org, coalesce(v_deal_name, 'מכירה מהירה, ' || to_char(v_day, 'DD.MM.YYYY')), v_pipeline,
          coalesce(v_open, v_stage), v_contact)
  returning id into v_deal;

  -- the business's VAT mode for a deal with no lines yet, and the rate that carries a price between the modes
  -- (= conversionRateBp(): the day's document rate; the status is known here)
  v_mode := coalesce((select s.prices_include_vat from public.org_document_settings s where s.organization_id = p_org), false);
  v_conv := case when app.org_charges_vat(p_org) is distinct from false then coalesce(app.vat_rate_at(v_day), 0) else 0 end;

  -- 3. the lines (PKG-01: a punch-card line is recorded by the trigger deal_lines_quick_sale while the setting names the deal)
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

  perform set_config('app.quick_sale_deal', '', true);
  return jsonb_build_object('deal_id', v_deal, 'contact_id', v_contact, 'payment_id', v_payments[1],
                            'payment_ids', to_jsonb(v_payments), 'document_id', v_document, 'total_agorot', v_total);
end;
$$;

revoke all on function public.quick_sale(uuid, jsonb) from public, anon;
grant execute on function public.quick_sale(uuid, jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- The quick sale's cards (second review finding 6, third review finding 1, fourth review finding 4, owner (107) ב)
-- ----------------------------------------------------------------------------
-- public.punch_card_open_for_sale(org, deal) (definer; whoever records payments in a writable business, on a deal and a
-- contact they read, with the key): only a deal carrying quick_sale_at (hint punch_card:not_quick_sale). It opens the punch
-- card units the sale recorded (app.quick_sale_lines), each at its exact share of what the sale charged (the sale's counted
-- payments' amounts split over the recorded lines by their weights, then over the line's units: app.punch_split), while
-- the room holds (the sale's counted payments, each less its live cards and its counted allocations: app.punch_cards_room).
-- Each card links to the sale payment with the most room and keeps its deal line (never twice). Answers {opened, failed}.
create or replace function public.punch_card_open_for_sale(p_org uuid, p_deal uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_deal record;
  v_total bigint;
  v_ids uuid[];
  v_weights numeric[];
  v_shares bigint[];
  v_line record;
  v_prices bigint[];
  v_share bigint;
  v_target integer;
  v_have integer;
  v_unit integer;
  v_price bigint;
  v_payment uuid;
  v_card uuid;
  v_opened integer := 0;
  v_failed integer := 0;
begin
  if not app.punch_card_seller(p_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select d.id, d.contact_id, d.owner_id, d.team_id, d.quick_sale_at into v_deal from public.deals d
   where d.organization_id = p_org and d.id = p_deal and d.deleted_at is null;
  if not found or not app.can_read_record(p_org, v_deal.owner_id, v_deal.team_id)
     or v_deal.contact_id is null or not app.punch_card_contact_ok(p_org, v_deal.contact_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not app.org_has_feature(p_org, 'punch_cards') then
    raise exception 'punch cards are not in the plan' using errcode = 'P0001', hint = 'feature:punch_cards';
  end if;
  if v_deal.quick_sale_at is null then
    raise exception 'not a quick sale' using errcode = 'P0001', hint = 'punch_card:not_quick_sale';
  end if;
  -- the sale's payments, in id order (two openings of one sale wait for each other here; no advisory key: no order or quote)
  perform 1 from public.payments pm
    where pm.organization_id = p_org and pm.deal_id = p_deal and pm.contact_id = v_deal.contact_id
    order by pm.id for update;
  select coalesce(sum(pm.amount_agorot), 0) into v_total from public.payments pm
   where pm.organization_id = p_org and pm.deal_id = p_deal and pm.contact_id = v_deal.contact_id and pm.status in ('recorded', 'confirmed');
  select array_agg(s.deal_line_id order by s.position, s.deal_line_id), array_agg(s.weight_agorot::numeric order by s.position, s.deal_line_id)
    into v_ids, v_weights
    from app.quick_sale_lines s where s.organization_id = p_org and s.deal_id = p_deal;
  v_shares := app.punch_split(v_total, v_weights);
  for v_line in
    select s.deal_line_id as id, s.units, l.product_id, p.name, p.punch_entries, p.punch_validity_count, p.punch_validity_unit, l.quantity
      from app.quick_sale_lines s
      join public.deal_lines l on l.organization_id = s.organization_id and l.id = s.deal_line_id
      join public.products p on p.organization_id = l.organization_id and p.id = l.product_id
     where s.organization_id = p_org and s.deal_id = p_deal and s.is_punch and s.units > 0
       and p.kind = 'punch_card' and p.punch_entries is not null
     order by s.position, s.deal_line_id
  loop
    v_target := v_line.units;
    v_share := v_shares[array_position(v_ids, v_line.id)];
    v_prices := case when v_share is null then '{}'::bigint[]
                     else (app.punch_split(v_share, array_fill(1::numeric, array[v_target])))[1:v_target] end;
    v_have := (select count(*) from public.punch_cards c where c.organization_id = p_org and c.deal_line_id = v_line.id);
    while v_have < v_target loop
      select min(n) into v_unit from generate_series(1, 20) n
       where not exists (select 1 from public.punch_cards c where c.organization_id = p_org and c.deal_line_id = v_line.id and c.unit_no = n);
      if v_unit is null or v_unit > coalesce(cardinality(v_prices), 0) then
        v_failed := v_failed + (v_target - v_have);
        exit;
      end if;
      v_price := v_prices[v_unit];
      select x.id into v_payment from (
        select pm.id, app.punch_cards_room(p_org, pm.id, null, null, 'link') as room
          from public.payments pm
         where pm.organization_id = p_org and pm.deal_id = p_deal and pm.contact_id = v_deal.contact_id
           and pm.status in ('recorded', 'confirmed')) x
       order by x.room desc, x.id limit 1;
      if v_payment is null
         or coalesce((select sum(greatest(app.punch_cards_room(p_org, pm.id, null, null, 'link'), 0)) from public.payments pm
                       where pm.organization_id = p_org and pm.deal_id = p_deal and pm.contact_id = v_deal.contact_id
                         and pm.status in ('recorded', 'confirmed')), 0) < v_price then
        v_failed := v_failed + (v_target - v_have);
        exit;
      end if;
      v_card := null;
      insert into public.punch_cards (organization_id, contact_id, product_id, name, entries_total, validity_count, validity_unit,
                                      status, payment_id, activated_at, activated_by, expires_on, price_agorot, deal_line_id, unit_no)
      values (p_org, v_deal.contact_id, v_line.product_id, v_line.name, v_line.punch_entries, v_line.punch_validity_count,
              v_line.punch_validity_unit, 'active', v_payment, now(), auth.uid(),
              app.punch_card_expires_on(app.punch_card_today(p_org), v_line.punch_validity_count, v_line.punch_validity_unit),
              v_price, v_line.id, v_unit)
      on conflict (organization_id, deal_line_id, unit_no) where deal_line_id is not null do nothing
      returning id into v_card;
      v_have := v_have + 1;
      if v_card is not null then
        v_opened := v_opened + 1;
      end if;
    end loop;
  end loop;
  return jsonb_build_object('opened', v_opened, 'failed', v_failed);
end;
$$;
revoke all on function public.punch_card_open_for_sale(uuid, uuid) from public, anon;
grant execute on function public.punch_card_open_for_sale(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
