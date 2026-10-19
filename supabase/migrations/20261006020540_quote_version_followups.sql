-- =============================================================================
-- QUO-12 follow-ups: the owner's answers of 19 October 2026 (DECISIONS.md, QUO-12 answers 5-7)
-- =============================================================================
-- (5) A version of a quote whose line names a product that has since been archived or switched off is still made; the
--     line is copied as it is and the screen marks it "המוצר בארכיון". app.quote_lines_check (the body of 020105) lets such
--     a line in only for quote_new_version's own copy: the function names the new draft in the transaction setting
--     app.quote_version_copy around its insert, and the trigger also needs the draft's previous quote to hold a line of the
--     same product, so a person's insert (or anything else) is refused as before (hint quote_lines:product). Sending the
--     draft is not refused for it (quote_send never checked the catalog); the customer's page shows the line as any other.
-- (6) A version may be made from a declined (rejected) or expired quote too, never from an accepted or cancelled one:
--     public.quote_new_version (the body of 020430) and app.quotes_version_guard (the body of 020420). Sending a version is
--     refused only while its previous quote is ACCEPTED (hint quote_version:previous_decided, unchanged); a declined previous
--     no longer blocks. Every other guard stays (quote:superseded, quote:no_redraft, the chain fixed, same deal and contact).
--     The customer's old link of a declined quote shows the newest sent version once it has a link of its own (unchanged
--     rule, app.quote_shown_version + app.quote_link_shows); an expired quote's own link stays closed (020420, known).
-- (7) public.quote_public (the body of 020515) adds `draft_version`: true while a draft version follows the quote shown,
--     so the page shows "גרסה מעודכנת בהכנה"; no id or content of the draft. The old link keeps showing the sent quote
--     until the version is sent (unchanged).
-- Safe to run twice.

-- (5) the line trigger
create or replace function app.quote_lines_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
  v_kind text;
  v_active boolean;
  v_archived timestamptz;
  v_billing text;
  v_unit text;
  v_name text;
  v_totals jsonb;
begin
  select * into v_quote from public.quotes q where q.organization_id = new.organization_id and q.id = new.quote_id;
  -- outsider guard: RLS refuses (42501) a person who may not edit the quote
  if auth.uid() is not null and (not found or not app.quote_editable(v_quote.organization_id, v_quote.deal_id, v_quote.contact_id)) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('quote_lines:' || new.quote_id::text, 0));
    if (select count(*) from public.quote_lines l
         where l.organization_id = new.organization_id and l.quote_id = new.quote_id) >= 200 then
      raise exception 'at most 200 lines in a quote' using errcode = 'P0001', hint = 'quote_lines:max';
    end if;
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
        -- QUO-12 (owner, 19 October 2026): a new version keeps a line whose product left the catalog as it is. Only
        -- quote_new_version's copy (app.quote_version_copy names the new draft) passes, and only for a product the previous
        -- version already had on a line; a person's own insert is refused as before.
        if auth.uid() is not null and (not v_active or v_archived is not null)
           and not (coalesce(current_setting('app.quote_version_copy', true), '') = new.quote_id::text
                    and v_quote.previous_id is not null
                    and exists (select 1 from public.quote_lines pl
                                 where pl.organization_id = new.organization_id and pl.quote_id = v_quote.previous_id
                                   and pl.product_id = new.product_id)) then
          raise exception 'the product cannot be offered' using errcode = 'P0001', hint = 'quote_lines:product';
        end if;
        new.vat_exempt := v_kind <> 'taxable';
        new.billing := v_billing;
        new.unit_name := v_unit;
      end if;
      -- not found: the foreign key refuses the row (23503)
    else
      new.unit_name := null;
    end if;
  else
    new.organization_id := old.organization_id;
    new.quote_id := old.quote_id;
    new.kind := old.kind;
    new.product_id := old.product_id;
    new.unit_name := old.unit_name;
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

  if (new.discount_bp is not null or new.discount_agorot is not null)
     and (tg_op = 'INSERT' or new.discount_bp is distinct from old.discount_bp
          or new.discount_agorot is distinct from old.discount_agorot)
     and not app.org_has_feature(new.organization_id, 'discounts') then
    raise exception 'discounts are not in this plan' using errcode = 'P0001', hint = 'feature:discounts';
  end if;

  -- the price list that set the price (PL-03); its name is kept with the line
  if new.price_source <> 'price_list' then
    if new.price_list_id is not null and auth.uid() is not null then
      raise exception 'only a price from a price list names a list' using errcode = 'P0001', hint = 'quote_lines:price_list';
    end if;
    new.price_list_id := null;
    new.price_list_name := null;
  elsif new.price_list_id is not null
        and (tg_op = 'INSERT' or new.price_list_id is distinct from old.price_list_id) then
    if not app.org_has_feature(new.organization_id, 'price_lists') then
      raise exception 'price lists are not in this plan' using errcode = 'P0001', hint = 'feature:price_lists';
    end if;
    select l.name into v_name from public.price_lists l
     where l.organization_id = new.organization_id and l.id = new.price_list_id;
    new.price_list_name := v_name;
  elsif tg_op = 'INSERT' then
    raise exception 'a price from a price list names the list' using errcode = 'P0001', hint = 'quote_lines:price_list';
  elsif new.price_list_id is null and old.price_source = 'price_list' then
    -- its list was removed (on delete set null): the line keeps the name it was priced by
    new.price_list_name := old.price_list_name;
  else
    new.price_list_name := old.price_list_name;
  end if;

  v_totals := app.document_totals(
    jsonb_build_array(jsonb_build_object(
      'quantity', new.quantity,
      'unit_price_agorot', new.unit_price_agorot,
      'discount_bp', new.discount_bp,
      'discount_agorot', new.discount_agorot,
      'vat_exempt', new.vat_exempt)),
    0, coalesce(v_quote.prices_include_vat, false));
  new.total_agorot := (v_totals #>> '{lines,0,total_agorot}')::bigint;
  return new;
end;
$$;
revoke all on function app.quote_lines_check() from public, anon, authenticated;

-- (5), (6) making a version
create or replace function public.quote_new_version(p_org uuid, p_quote uuid) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
  v_new uuid;
  v_today date;
  v_valid date;
begin
  select * into v_quote from public.quotes q where q.organization_id = p_org and q.id = p_quote for update;
  if not found or not app.quote_editable(p_org, v_quote.deal_id, v_quote.contact_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.org_has_feature(p_org, 'quotes') then
    raise exception 'quotes are not in this plan' using errcode = 'P0001', hint = 'feature:quotes';
  end if;
  if v_quote.status = 'draft' then
    raise exception 'a draft is edited, not versioned' using errcode = 'P0001', hint = 'quote_version:draft';
  end if;
  -- QUO-12 (owner, 19 October 2026): also from a declined or expired quote; never from an accepted or cancelled one
  if v_quote.status not in ('sent', 'viewed', 'rejected', 'expired') then
    raise exception 'a decided or closed quote is locked' using errcode = 'P0001', hint = 'quote_version:closed';
  end if;
  if exists (select 1 from public.quotes q where q.organization_id = p_org and q.previous_id = p_quote) then
    raise exception 'the quote already has a newer version' using errcode = 'P0001', hint = 'quote_version:exists';
  end if;

  select (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date into v_today
    from public.organizations o where o.id = p_org;
  v_valid := case
    when v_quote.valid_until is null then null
    when v_quote.valid_until >= v_today then v_quote.valid_until
    else v_today + (v_quote.valid_until - v_quote.quote_date) end;

  -- GAP-10: a version of an addendum stays an addendum of the same original
  insert into public.quotes (organization_id, title, deal_id, contact_id, company_id, valid_until, prices_include_vat,
                             no_vat_reason, no_vat_note, discount_bp, discount_agorot, notes, terms, currency, previous_id,
                             addendum_of)
  values (p_org, v_quote.title, v_quote.deal_id, v_quote.contact_id, v_quote.company_id, v_valid, v_quote.prices_include_vat,
          v_quote.no_vat_reason, v_quote.no_vat_note, v_quote.discount_bp, v_quote.discount_agorot, v_quote.notes,
          v_quote.terms, v_quote.currency, p_quote, v_quote.addendum_of)
  returning id into v_new;
  -- a new quote takes the business's VAT mode; the version keeps the original's, before any line is added
  update public.quotes q set prices_include_vat = v_quote.prices_include_vat
   where q.organization_id = p_org and q.id = v_new and q.prices_include_vat is distinct from v_quote.prices_include_vat;

  -- QUO-12: the lines are copied as they are, a product that left the catalog included (app.quote_lines_check)
  perform set_config('app.quote_version_copy', v_new::text, true);
  insert into public.quote_lines (organization_id, quote_id, position, kind, product_id, name, description, quantity,
                                  unit_price_agorot, discount_bp, discount_agorot, vat_exempt, billing, is_optional,
                                  optional_selected, price_source, price_list_id, currency)
  select l.organization_id, v_new, l.position, l.kind, l.product_id, l.name, l.description, l.quantity,
         l.unit_price_agorot, l.discount_bp, l.discount_agorot, l.vat_exempt, l.billing, l.is_optional,
         l.optional_selected, l.price_source, l.price_list_id, l.currency
    from public.quote_lines l
   where l.organization_id = p_org and l.quote_id = p_quote
   order by l.position, l.id;
  perform set_config('app.quote_version_copy', '', true);

  insert into public.quote_payment_steps (organization_id, quote_id, position, name, percent_bp, due_date, milestone)
  select s.organization_id, v_new, s.position, s.name, s.percent_bp, s.due_date, s.milestone
    from public.quote_payment_steps s
   where s.organization_id = p_org and s.quote_id = p_quote
   order by s.position, s.id;

  return v_new;
end;
$$;
revoke all on function public.quote_new_version(uuid, uuid) from public, anon;
grant execute on function public.quote_new_version(uuid, uuid) to authenticated;

-- (6) the chain's guard
create or replace function app.quotes_version_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_previous public.quotes;
  v_previous_status text;
begin
  if tg_op = 'INSERT' then
    if new.previous_id is not null then
      select * into v_previous from public.quotes q where q.organization_id = new.organization_id and q.id = new.previous_id;
      -- QUO-12 (owner, 19 October 2026): from a sent, viewed, declined or expired quote
      if not found or v_previous.status not in ('sent', 'viewed', 'rejected', 'expired') then
        raise exception 'a new version is made from a quote that was sent' using errcode = 'P0001', hint = 'quote_version:not_sent';
      end if;
      if new.deal_id is distinct from v_previous.deal_id or new.contact_id is distinct from v_previous.contact_id then
        raise exception 'a version belongs to the same deal and contact' using errcode = 'P0001', hint = 'quote_version:parent';
      end if;
    end if;
    return new;
  end if;

  -- the chain is fixed; only its foreign key may clear it
  if new.previous_id is distinct from old.previous_id and new.previous_id is not null then
    raise exception 'the version chain cannot change' using errcode = 'P0001', hint = 'quote_version:fixed';
  end if;
  -- QUO-11 review: once a newer version was sent, this quote is superseded and is never accepted or declined, by any path
  if new.status in ('accepted', 'rejected') and new.status is distinct from old.status
     and exists (select 1 from public.quotes q
                  where q.organization_id = new.organization_id and q.previous_id = new.id and q.sent_at is not null) then
    raise exception 'a newer version of this quote was sent' using errcode = 'P0001', hint = 'quote:superseded';
  end if;
  if old.status <> 'draft' and new.status = 'draft' then
    raise exception 'a quote that was sent never returns to draft' using errcode = 'P0001', hint = 'quote:no_redraft';
  end if;
  -- QUO-11 review: a version is never sent after its previous quote was accepted or declined (the draft stays a draft and
  -- may be deleted). The previous quote is taken FOR SHARE, so a decision on it in flight (quote_public_decide holds it FOR
  -- UPDATE) is waited for and seen, and a decision that comes after waits for this send and then finds it superseded.
  if old.status = 'draft' and new.status <> 'draft' and new.previous_id is not null then
    select q.status into v_previous_status from public.quotes q
     where q.organization_id = new.organization_id and q.id = new.previous_id
       for share;
    -- QUO-12 (owner, 19 October 2026): a declined previous quote no longer blocks; an accepted one does
    if v_previous_status = 'accepted' then
      raise exception 'the previous version was already accepted' using errcode = 'P0001', hint = 'quote_version:previous_decided';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.quotes_version_guard() from public, anon, authenticated, service_role;

-- (7) the customer's page
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
  v_lines jsonb;
  v_built_with boolean;
  v_schedule jsonb;
  -- QUO-12: the quote the link was made for, when the page shows a newer version of it
  v_opened public.quotes;
  v_next public.quotes;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_link from app.quote_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = v_link.organization_id and q.id = v_link.quote_id;

  -- QUO-11 (owner, 19 October 2026): an accepted quote that was cancelled, the link's own or the newest version it shows,
  -- says "cancelled": its number and title and the business's name and brand, never prices, lines or a way to sign
  if v_quote.id is not null and app.org_public_pages_open(v_quote.organization_id) and app.org_has_feature(v_quote.organization_id, 'quotes') then
    v_next := app.quote_shown_version(v_quote);
    -- a purged customer's quote answers not found, as on the normal path (app.quote_link_open)
    if v_next.status = 'cancelled' and v_next.cancelled_from = 'accepted' and v_next.customer_deleted_at is null then
      update app.quote_links l
         set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
             window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end
       where l.quote_id = v_link.quote_id
      returning l.window_count into v_count;
      if v_count > 120 then
        return jsonb_build_object('rate_limited', true);
      end if;
      select * into v_org from public.organizations o where o.id = v_next.organization_id;
      select * into v_design from public.quote_designs d where d.organization_id = v_next.organization_id;
      select * into v_settings from public.org_document_settings s where s.organization_id = v_next.organization_id;
      return jsonb_build_object('cancelled', jsonb_build_object(
        'number', v_next.number_display,
        'title', v_next.title,
        'business', coalesce(nullif(btrim(v_settings.legal_name), ''), v_org.name),
        'logo', case when coalesce(v_design.show_logo, true) then v_org.logo_path end,
        'color', coalesce(v_design.accent_color, v_org.brand_color)));
    end if;
  end if;

  if v_quote.id is null or not app.quote_link_open(v_quote)
     or not app.org_public_pages_open(v_quote.organization_id)
     or not app.org_has_feature(v_quote.organization_id, 'quotes') then
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

  -- QUO-12 with the QUO-11 review rule: the newest version that was ever sent, shown while app.quote_link_shows allows;
  -- else the link answers not found (never the superseded quote)
  v_next := app.quote_shown_version(v_quote);
  if not app.quote_link_shows(v_quote, v_next) then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  if v_next.id is distinct from v_quote.id then
    v_opened := v_quote;
    v_quote := v_next;
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
           'total_agorot', l.total_agorot) order by l.position, l.id), '[]'::jsonb)
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
      'accent_color', v_design.accent_color),
    'brand', jsonb_build_object('logo', case when v_show_logo then v_org.logo_path end, 'color', v_org.brand_color),
    'built_with', v_built_with,
    -- QUO-12: the number the customer's link was made for, when this is a newer version of it (else null)
    'replaced', case when v_opened.id is not null then jsonb_build_object('number', v_opened.number_display) end,
    -- QUO-12 (owner, 19 October 2026): a newer version is being prepared (a draft after the quote shown); no id or content
    'draft_version', exists (select 1 from public.quotes d
                              where d.organization_id = v_quote.organization_id and d.previous_id = v_quote.id
                                and d.status = 'draft'),
    -- GAP-10: the quote this one adds to (its number), and the accepted addenda of this one; numbers, titles and totals only
    'addendum', (select jsonb_build_object('number', o.number_display) from public.quotes o
                  where v_quote.addendum_of is not null and o.organization_id = v_quote.organization_id and o.id = v_quote.addendum_of),
    'addenda', coalesce((select jsonb_agg(jsonb_build_object('number', a.number_display, 'title', a.title, 'total_agorot', a.total_agorot)
                                          order by a.sent_at, a.number)
                           from public.quotes a
                          where a.organization_id = v_quote.organization_id and a.addendum_of = v_quote.id and a.status = 'accepted'),
                        '[]'::jsonb));
end;
$$;
revoke all on function public.quote_public(text) from public, anon, authenticated;
grant execute on function public.quote_public(text) to service_role;
