-- TAX-02, the rest: the business's bank details for a transfer are shown on the documents we issue to a customer:
-- the quote (QUO-05 document, the customer page of QUO-08, the PDF of QUO-06) and the order confirmation (ORD-05,
-- "not a tax invoice"; it doubles as the payment request). External DOC-01 documents are only recorded: out of scope.
--
-- Owner, 13 October 2026 ("פרטי בנק"): bank details are seen and edited in settings by owners and admins only
-- (public.org_bank_details, unchanged); other members see them only as part of a document they may see; a document
-- stores app.document_bank_snapshot(org) when it is made, so a later change of the bank details never changes it.
--
-- public.quotes.bank_details   jsonb, server only (no client grant; the table's select grant lets whoever reads the
--                              quote under quotes_select read it). Taken by the definer trigger quotes_zz_bank_details
--                              at the moment a quote leaves draft (quote_send, the numbering moment) and never changed
--                              afterwards, for every writer. A draft has none, so a new version (quote_new_version) or a
--                              duplicate (quote_duplicate) gets a fresh snapshot when it is sent, never a copy. A quote
--                              sent before this migration keeps none. quote_send itself is unchanged.
-- public.orders.bank_details   the same for an order, taken when the order gets its number (order_confirm, or an
--                              order made numbered by order_from_quote / order_from_deal), by orders_zz_bank_details.
-- public.quote_designs.show_bank_details_quote / show_bank_details_order   boolean not null default true each (owner,
--                              27 October 2026: shown by default, a separate switch per document type on the one design screen):
--                              whether the document shows the stored bank details. Column grants like the others.
--
-- Redefined: public.quote_public (latest body 020995) and public.order_public (latest body 020625), each only to add
-- `bank` (the stored snapshot, only when the design shows it for that document type) and `design.show_bank_details_quote`
-- (quote_public) or `design.show_bank_details_order` (order_public) to the full answer; their
-- not-found rules, rate limits and status pages are unchanged (test 253 pins their md5).
--
-- Redefined: app.audit_row (latest body 020020) only to add 'bank_details' to its ignored columns, so the snapshot (the full
-- account number) never enters audit_log (owner: bank details are logged without the full number).
--
-- Bank details are the business's, not a person's: no erasure work.
-- Every statement is safe to run twice. No drops, no row removal.

alter table public.quotes add column if not exists bank_details jsonb;
comment on column public.quotes.bank_details is
  'TAX-02: app.document_bank_snapshot() taken when the quote left draft; server only, never changed afterwards.';
alter table public.orders add column if not exists bank_details jsonb;
comment on column public.orders.bank_details is
  'TAX-02: app.document_bank_snapshot() taken when the order got its number; server only, never changed afterwards.';

alter table public.quote_designs add column if not exists show_bank_details_quote boolean not null default true;
alter table public.quote_designs add column if not exists show_bank_details_order boolean not null default true;
grant insert (show_bank_details_quote, show_bank_details_order) on public.quote_designs to authenticated;
grant update (show_bank_details_quote, show_bank_details_order) on public.quote_designs to authenticated;

-- ----------------------------------------------------------------------------
-- The snapshot. Definer: app.document_bank_snapshot is granted to service_role only, and the trigger reads the
-- business's own row for a document the writer may already write (RLS on quotes / orders decides that). Named to fire
-- after quotes_check / orders_check, so the status (or number) it judges is the one being stored.
-- ----------------------------------------------------------------------------
create or replace function app.quotes_bank_details() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- a new quote is a draft (quotes_check sets it for a person; versions and duplicates are drafts too)
    new.bank_details := case when new.status <> 'draft' then app.document_bank_snapshot(new.organization_id) end;
  elsif old.status = 'draft' and new.status <> 'draft' then
    -- the moment it is sent and numbered
    new.bank_details := app.document_bank_snapshot(new.organization_id);
  else
    new.bank_details := old.bank_details;
  end if;
  return new;
end;
$$;
revoke all on function app.quotes_bank_details() from public, anon, authenticated;

create or replace trigger quotes_zz_bank_details before insert or update on public.quotes
  for each row execute function app.quotes_bank_details();

create or replace function app.orders_bank_details() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- a manual draft has no number; order_from_quote / order_from_deal make it numbered
    new.bank_details := case when new.number is not null then app.document_bank_snapshot(new.organization_id) end;
  elsif old.number is null and new.number is not null then
    -- order_confirm numbers a draft
    new.bank_details := app.document_bank_snapshot(new.organization_id);
  else
    new.bank_details := old.bank_details;
  end if;
  return new;
end;
$$;
revoke all on function app.orders_bank_details() from public, anon, authenticated;

create or replace trigger orders_zz_bank_details before insert or update on public.orders
  for each row execute function app.orders_bank_details();

-- ----------------------------------------------------------------------------
-- quote_public: 020995's body, plus `bank` and design.show_bank_details_quote
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
  -- TAX-02: the bank details stored on the quote when it was sent, when the design shows them
  v_show_bank boolean;
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

  -- owner, 19 October 2026: the link of a quote that was sent never answers not found. Not found only for a token that does
  -- not exist or was revoked (its hash cleared), a draft, a customer erased or purged (customer_deleted_at), a business whose
  -- public pages are closed, or one without quotes
  if not app.quote_link_usable(v_quote) then
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

  -- the newest version of the chain that was ever sent (QUO-12, the QUO-11 review rule), whether or not it has a link of its
  -- own; never an older one
  v_next := app.quote_shown_version(v_quote);
  if v_next.customer_deleted_at is not null then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  if v_next.id is distinct from v_quote.id then
    v_opened := v_quote;
    v_quote := v_next;
  end if;

  -- declined, cancelled, or past its date: a status page with no prices, lines or a way to sign (owner, 19 October 2026: an
  -- accepted quote is shown in full, with the day it was accepted and no way to decide)
  if not app.quote_offer_open(v_quote) and v_quote.status <> 'accepted' then
    select * into v_org from public.organizations o where o.id = v_quote.organization_id;
    select * into v_design from public.quote_designs d where d.organization_id = v_quote.organization_id;
    select * into v_settings from public.org_document_settings s where s.organization_id = v_quote.organization_id;
    return jsonb_build_object('status_page', jsonb_build_object(
      'state', case when v_quote.status in ('rejected', 'cancelled') then v_quote.status else 'expired' end,
      'number', v_quote.number_display,
      'title', v_quote.title,
      'valid_until', v_quote.valid_until,
      -- documents use the registered name when set (owner)
      'business', coalesce(nullif(btrim(v_settings.legal_name), ''), v_org.name),
      'logo', case when coalesce(v_design.show_logo, true) then v_org.logo_path end,
      'color', coalesce(v_design.accent_color, v_org.brand_color),
      'phone', coalesce(nullif(btrim(v_settings.phone), ''), nullif(btrim(v_org.phone), '')),
      'replaced', case when v_opened.id is not null then jsonb_build_object('number', v_opened.number_display) end,
      -- a newer version is being prepared (QUO-12 answer 7)
      'draft_version', exists (select 1 from public.quotes d
                                where d.organization_id = v_quote.organization_id and d.previous_id = v_quote.id
                                  and d.status = 'draft')));
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
  v_show_bank := coalesce(v_design.show_bank_details_quote, true);

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
      'show_bank_details_quote', v_show_bank,
      'accent_color', v_design.accent_color),
    'brand', jsonb_build_object('logo', case when v_show_logo then v_org.logo_path end, 'color', v_org.brand_color),
    'built_with', v_built_with,
    -- TAX-02: the business's bank details for a transfer, as stored on the quote when it was sent (never the live settings);
    -- only when the design shows them and the quote has them
    'bank', case when v_show_bank and v_quote.bank_details is not null then jsonb_build_object(
                   'bank_name', v_quote.bank_details ->> 'bank_name',
                   'bank_branch', v_quote.bank_details ->> 'bank_branch',
                   'bank_account', v_quote.bank_details ->> 'bank_account',
                   'bank_account_name', v_quote.bank_details ->> 'bank_account_name') end,
    -- QUO-12: the number the customer's link was made for, when this is a newer version of it (else null)
    'replaced', case when v_opened.id is not null then jsonb_build_object('number', v_opened.number_display) end,
    -- owner, 19 October 2026: the day an accepted quote was accepted, in the business's zone (null otherwise)
    'accepted_on', case when v_quote.status = 'accepted' then
                     (select (d.decided_at at time zone app.intake_zone(v_org.timezone))::date
                        from public.quote_decisions d
                       where d.organization_id = v_quote.organization_id and d.quote_id = v_quote.id and d.decision = 'accepted') end,
    -- QUO-12 (owner, 19 October 2026): a newer version is being prepared (a draft after the quote shown); no id or content
    'draft_version', exists (select 1 from public.quotes d
                              where d.organization_id = v_quote.organization_id and d.previous_id = v_quote.id
                                and d.status = 'draft'),
    -- GAP-10: the quote this one adds to (its number), and the accepted addenda of this one; numbers, titles and totals only
    'addendum', (select jsonb_build_object('number', o.number_display) from public.quotes o
                  where v_quote.addendum_of is not null and o.organization_id = v_quote.organization_id and o.id = v_quote.addendum_of),
    -- QUO-06 (owner's answer 1): the customer may download the stored PDF of the version shown
    'pdf', exists (select 1 from public.files f
                    where f.organization_id = v_quote.organization_id and f.quote_id = v_quote.id
                      and f.unconfirmed_since is null and f.sha256 is not null),
    'addenda', coalesce((select jsonb_agg(jsonb_build_object('number', a.number_display, 'title', a.title, 'total_agorot', a.total_agorot)
                                          order by a.sent_at, a.number)
                           from public.quotes a
                          where a.organization_id = v_quote.organization_id and a.addendum_of = v_quote.id and a.status = 'accepted'),
                        '[]'::jsonb));
end;
$$;
revoke all on function public.quote_public(text) from public, anon, authenticated;
grant execute on function public.quote_public(text) to service_role;

-- ----------------------------------------------------------------------------
-- order_public: 020625's body, plus `bank` and design.show_bank_details_order
-- ----------------------------------------------------------------------------
create or replace function public.order_public(p_token text, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_link app.order_links;
  v_order public.orders;
  v_count integer;
  v_bucket integer;
  v_views integer;
  v_design public.quote_designs;
  v_settings public.org_document_settings;
  v_org public.organizations;
  v_decision public.order_decisions;
  v_show_details boolean;
  v_show_logo boolean;
  -- TAX-02: the bank details stored on the order when it was numbered, when the design shows them
  v_show_bank boolean;
  v_lines jsonb;
  v_schedule jsonb;
  v_built_with boolean;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'order not found' using errcode = 'P0002';
  end if;
  select * into v_link from app.order_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then
    raise exception 'order not found' using errcode = 'P0002';
  end if;
  select * into v_order from public.orders o where o.organization_id = v_link.organization_id and o.id = v_link.order_id;
  if not found or not app.order_link_usable(v_order) then
    raise exception 'order not found' using errcode = 'P0002';
  end if;

  -- 120 views per link in 10 minutes; counted first, so the limit holds under parallel load
  update app.order_links l
     set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
         window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end
   where l.order_id = v_link.order_id
  returning l.window_count into v_count;
  if v_count > 120 then
    return jsonb_build_object('rate_limited', true);
  end if;
  -- FXS-11: 60 views per sender in 10 minutes, by the server's keyed IP hash scoped to this order
  if p_ip_hash is not null then
    v_bucket := ((hashtextextended(app.order_link_sender(v_order.id, p_ip_hash), 0) % 1024) + 1024) % 1024;
    insert into app.order_link_view_counts as vc (order_id, bucket, window_start, views)
    values (v_order.id, v_bucket, now(), 1)
    on conflict (order_id, bucket) do update
      set window_start = case when vc.window_start > now() - interval '10 minutes' then vc.window_start else now() end,
          views = case when vc.window_start > now() - interval '10 minutes' then vc.views + 1 else 1 end
    returning vc.views into v_views;
    if v_views > 60 then
      return jsonb_build_object('rate_limited', true);
    end if;
  end if;

  select * into v_org from public.organizations o where o.id = v_order.organization_id;
  select * into v_design from public.quote_designs d where d.organization_id = v_order.organization_id;
  select * into v_settings from public.org_document_settings s where s.organization_id = v_order.organization_id;
  -- QUO-05: no design row = the defaults (logo and business details shown)
  v_show_details := coalesce(v_design.show_business_details, true);
  v_show_logo := coalesce(v_design.show_logo, true);
  v_show_bank := coalesce(v_design.show_bank_details_order, true);

  -- a cancelled order: its state only, no prices or lines (the one rule for a sent link)
  if v_order.status = 'cancelled' then
    return jsonb_build_object('status_page', jsonb_build_object(
      'state', 'cancelled',
      'number', v_order.number_display,
      -- documents use the registered name when set (owner)
      'business', coalesce(nullif(btrim(v_settings.legal_name), ''), v_org.name),
      'logo', case when v_show_logo then v_org.logo_path end,
      'color', coalesce(v_design.accent_color, v_org.brand_color),
      'phone', coalesce(nullif(btrim(v_settings.phone), ''), nullif(btrim(v_org.phone), ''))));
  end if;

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
           'total_agorot', l.total_agorot) order by l.position, l.id), '[]'::jsonb)
    into v_lines
    from public.order_lines l
   where l.organization_id = v_order.organization_id and l.order_id = v_order.id;

  -- ORD-04: each step with its share of the total (cumulative shares, half up, = scheduleAmounts())
  select coalesce(jsonb_agg(jsonb_build_object(
           'name', r.name,
           'percent_bp', r.percent_bp,
           'due_date', r.due_date,
           'milestone', r.milestone,
           'amount_agorot', round(v_order.total_agorot::numeric * r.cum / 10000) - round(v_order.total_agorot::numeric * (r.cum - r.percent_bp) / 10000))
         order by r.position, r.id), '[]'::jsonb)
    into v_schedule
    from (select s.id, s.position, s.name, s.percent_bp, s.due_date, s.milestone,
                 sum(s.percent_bp) over (order by s.position, s.id) as cum
            from public.order_payment_steps s
           where s.organization_id = v_order.organization_id and s.order_id = v_order.id) r;

  select * into v_decision from public.order_decisions d where d.organization_id = v_order.organization_id and d.order_id = v_order.id;

  begin
    v_built_with := coalesce(app.show_built_with(v_order.organization_id), true);
  exception when others then
    v_built_with := true;
  end;

  return jsonb_build_object(
    'order', jsonb_build_object(
      'number', v_order.number_display,
      'status', v_order.status,
      'order_date', v_order.order_date,
      'delivery_date', v_order.delivery_date,
      'shipping_address', v_order.shipping_address,
      'notes', v_order.notes,
      'prices_include_vat', v_order.prices_include_vat,
      'no_vat_reason', v_order.no_vat_reason,
      'no_vat_note', v_order.no_vat_note,
      'discount_bp', v_order.discount_bp,
      'discount_agorot', v_order.discount_agorot,
      'vat_rate_bp', v_order.vat_rate_bp,
      'subtotal_agorot', v_order.subtotal_agorot,
      'discount_total_agorot', v_order.discount_total_agorot,
      'net_total_agorot', v_order.net_total_agorot,
      'vat_agorot', v_order.vat_agorot,
      'total_agorot', v_order.total_agorot,
      'currency', v_order.currency),
    -- the customer as named when the order was numbered (ORD-03); never the live record
    'customer', jsonb_build_object('name', v_order.customer_name),
    'lines', v_lines,
    'schedule', v_schedule,
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
      'show_bank_details_order', v_show_bank,
      'accent_color', v_design.accent_color),
    'brand', jsonb_build_object('logo', case when v_show_logo then v_org.logo_path end, 'color', v_org.brand_color),
    'built_with', v_built_with,
    -- TAX-02: the business's bank details for a transfer, as stored on the order when it was numbered (never the live
    -- settings); only when the design shows them and the order has them
    'bank', case when v_show_bank and v_order.bank_details is not null then jsonb_build_object(
                   'bank_name', v_order.bank_details ->> 'bank_name',
                   'bank_branch', v_order.bank_details ->> 'bank_branch',
                   'bank_account', v_order.bank_details ->> 'bank_account',
                   'bank_account_name', v_order.bank_details ->> 'bank_account_name') end,
    -- the customer's answer: what and when only
    'decision', case when v_decision.id is not null
                     then jsonb_build_object('decision', v_decision.decision, 'decided_at', v_decision.decided_at) end,
    -- what an answer must name, while the order waits for one
    'fingerprint', case when v_order.status = 'new' and v_decision.id is null then app.order_fingerprint(v_order) end);
end;
$$;
revoke all on function public.order_public(text, text) from public, anon, authenticated;
grant execute on function public.order_public(text, text) to service_role;

-- ----------------------------------------------------------------------------
-- app.audit_row: 020020's body (the latest), with 'bank_details' added to the ignored columns only. Owner, 13 October
-- 2026: bank details are logged without the full number; the snapshot a quote or order takes when it is sent or numbered
-- holds the full account number, so the update that stores it writes no change of it (and an update changing nothing else
-- writes no entry). An insert's entry holds no values; quotes and orders that hold a snapshot are never deleted by a person.
-- ----------------------------------------------------------------------------
create or replace function app.audit_row() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_org uuid;
  v_entity uuid;
  v_action text;
  v_changes jsonb := '{}'::jsonb;
  v_key text;
  v_rule uuid;
  v_ignored constant text[] := array['updated_at', 'updated_by', 'stage_entered_at', 'phone_e164', 'last_lead_assigned_at', 'reminded_at', 'score',
                                        -- TAX-02: the bank snapshot of a quote / order (the full account number) never enters the log
                                        'bank_details'];
begin
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;

  if tg_table_name = 'organizations' then
    v_org := coalesce(v_new ->> 'id', v_old ->> 'id')::uuid;
  else
    v_org := coalesce(v_new ->> 'organization_id', v_old ->> 'organization_id')::uuid;
  end if;
  v_entity := nullif(coalesce(v_new ->> 'id', v_old ->> 'id'), '')::uuid;

  if tg_op = 'INSERT' then
    v_action := 'insert';
  elsif tg_op = 'DELETE' then
    -- nothing to attach the entry to when the organization itself is going away
    if not app.org_exists(v_org) then
      return null;
    end if;
    v_action := 'delete';
    v_changes := v_old;
  else
    for v_key in select jsonb_object_keys(v_new) loop
      if v_key <> all (v_ignored) and (v_new -> v_key) is distinct from (v_old -> v_key) then
        v_changes := v_changes || jsonb_build_object(
          v_key, jsonb_build_object('old', v_old -> v_key, 'new', v_new -> v_key));
      end if;
    end loop;
    if v_changes = '{}'::jsonb then
      return null;
    end if;
    v_action := case
      when v_changes ? 'deleted_at' and (v_new ->> 'deleted_at') is not null then 'trash'
      when v_changes ? 'deleted_at' then 'restore'
      else 'update'
    end;
  end if;

  -- PRM-01: an insert or update an automation made names the rule, as it is named now (kept in the
  -- entry, never looked up again); a delete's entry carries no name. The rule comes from
  -- app.automation_rule_runs, written only by app.execute_automation for this transaction (no row
  -- when its slot was held by another transaction), and only a rule of this entry's business
  -- counts. A plain value, not an {old, new} pair, so lists show it as context.
  if tg_op <> 'DELETE' then
    select r.rule_id into v_rule from app.automation_rule_runs r
     where r.slot = (txid_current() % 65536)::integer and r.txid = txid_current()
       and r.organization_id = v_org and r.rule_id is not null;
    if v_rule is not null then
      v_changes := v_changes || jsonb_build_object('automation', jsonb_build_object(
        'id', v_rule,
        'name', (select a.name from public.automations a where a.id = v_rule and a.organization_id = v_org)));
    end if;
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (v_org, auth.uid(), v_action, tg_table_name, v_entity, v_changes);
  return null;
end;
$$;

