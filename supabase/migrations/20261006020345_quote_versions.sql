-- QUO-12: quote versions (owner, 18 October 2026, answer (א) of the QUO-04/QUO-12 question).
--
-- * Editing a sent quote makes a new version: a copy (the quote, its lines and its payment steps) that is a draft until it
--   is sent, and takes a new running number when it is (quote_send, unchanged). public.quote_new_version(org, quote) makes it,
--   all or nothing, for whoever may edit the quote's deal or contact, from a quote that was sent and not yet decided
--   (status sent or viewed; an accepted quote is locked, spec QUO-12). The copy is dated today: a validity date that has
--   passed keeps its length from today; its VAT mode is the original's, its VAT rate today's (the document is new).
-- * quotes.previous_id links a version to the one it replaces: at most one newer version per quote (unique), set only by
--   that function (no client grant), never changed later except cleared by its foreign key.
-- * A quote that is no longer a draft never returns to draft, for every writer (hint quote:no_redraft).
-- * The original is marked "הוחלפה בגרסה [מספר]" in the app once its newer version is sent. Its customer link answers with
--   the newest version that is sent and has a working link of its own, with `replaced` naming the number the customer
--   opened (public.quote_public, same signature and the same single definer function for the page); until then it shows
--   the quote it was made for.

alter table public.quotes add column if not exists previous_id uuid;
alter table public.quotes drop constraint if exists quotes_previous_fk;
alter table public.quotes add constraint quotes_previous_fk foreign key (organization_id, previous_id)
  references public.quotes (organization_id, id) on delete set null (previous_id);
-- one newer version per quote; also the index of the foreign key
alter table public.quotes drop constraint if exists quotes_previous_unique;
alter table public.quotes add constraint quotes_previous_unique unique (organization_id, previous_id);

-- ----------------------------------------------------------------------------
-- The chain and the one-way status
-- ----------------------------------------------------------------------------
create or replace function app.quotes_version_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_previous public.quotes;
begin
  if tg_op = 'INSERT' then
    if new.previous_id is not null then
      select * into v_previous from public.quotes q where q.organization_id = new.organization_id and q.id = new.previous_id;
      if not found or v_previous.status not in ('sent', 'viewed') then
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
  if old.status <> 'draft' and new.status = 'draft' then
    raise exception 'a quote that was sent never returns to draft' using errcode = 'P0001', hint = 'quote:no_redraft';
  end if;
  return new;
end;
$$;
revoke all on function app.quotes_version_guard() from public, anon, authenticated, service_role;

create or replace trigger quotes_version_guard before insert or update on public.quotes
  for each row execute function app.quotes_version_guard();

-- ----------------------------------------------------------------------------
-- Making a version
-- ----------------------------------------------------------------------------
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
  if v_quote.status not in ('sent', 'viewed') then
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

  insert into public.quotes (organization_id, title, deal_id, contact_id, company_id, valid_until, prices_include_vat,
                             no_vat_reason, no_vat_note, discount_bp, discount_agorot, notes, terms, currency, previous_id)
  values (p_org, v_quote.title, v_quote.deal_id, v_quote.contact_id, v_quote.company_id, v_valid, v_quote.prices_include_vat,
          v_quote.no_vat_reason, v_quote.no_vat_note, v_quote.discount_bp, v_quote.discount_agorot, v_quote.notes,
          v_quote.terms, v_quote.currency, p_quote)
  returning id into v_new;
  -- a new quote takes the business's VAT mode; the version keeps the original's, before any line is added
  update public.quotes q set prices_include_vat = v_quote.prices_include_vat
   where q.organization_id = p_org and q.id = v_new and q.prices_include_vat is distinct from v_quote.prices_include_vat;

  insert into public.quote_lines (organization_id, quote_id, position, kind, product_id, name, description, quantity,
                                  unit_price_agorot, discount_bp, discount_agorot, vat_exempt, billing, is_optional,
                                  optional_selected, price_source, price_list_id, currency)
  select l.organization_id, v_new, l.position, l.kind, l.product_id, l.name, l.description, l.quantity,
         l.unit_price_agorot, l.discount_bp, l.discount_agorot, l.vat_exempt, l.billing, l.is_optional,
         l.optional_selected, l.price_source, l.price_list_id, l.currency
    from public.quote_lines l
   where l.organization_id = p_org and l.quote_id = p_quote
   order by l.position, l.id;

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

-- ----------------------------------------------------------------------------
-- The customer's page (QUO-08, GAP-09; the body of 020310 with the chain added)
-- ----------------------------------------------------------------------------
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
  v_steps integer := 0;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_link from app.quote_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = v_link.organization_id and q.id = v_link.quote_id;
  if not found or not app.quote_link_open(v_quote)
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

  -- QUO-12: a newer version replaces the quote on its old link once that version is sent and has a working link of its own
  -- (the newest such one in the chain); until then the link shows the quote it was made for
  v_next := v_quote;
  loop
    select * into v_next from public.quotes q
     where q.organization_id = v_next.organization_id and q.previous_id = v_next.id;
    exit when not found;
    v_steps := v_steps + 1;
    exit when v_steps > 100;
    if app.quote_link_open(v_next)
       and exists (select 1 from app.quote_links l
                    where l.organization_id = v_next.organization_id and l.quote_id = v_next.id and l.token_hash is not null) then
      if v_opened.id is null then
        v_opened := v_quote;
      end if;
      v_quote := v_next;
    end if;
  end loop;

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
    'replaced', case when v_opened.id is not null then jsonb_build_object('number', v_opened.number_display) end);
end;
$$;
revoke all on function public.quote_public(text) from public, anon, authenticated;
grant execute on function public.quote_public(text) to service_role;
