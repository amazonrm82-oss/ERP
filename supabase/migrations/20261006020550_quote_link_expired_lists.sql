-- =============================================================================
-- QUO-12 / QUO-15 follow-ups: the owner's answers of 19 October 2026 to the questions of QUO-12b (DECISIONS.md)
-- =============================================================================
-- (1) The owner's rule (19 October 2026, unifying the expired page of this change and the cancelled page of 020515): the
--     link of a quote that was sent never answers not found. It leads to the newest SENT version of its chain (whether or
--     not that one has a link of its own) and shows its state: open (sent/viewed, not past its date) = the full page;
--     accepted = the full page with accepted_on (the day of its decision in the business's zone) and no way to decide;
--     declined, cancelled or expired (incl. past its date) = {status_page: {state, number, title, valid_until,
--     business, logo, color, phone, replaced, draft_version}}, no prices, lines or signing. Not found only for a token that
--     does not exist or was revoked, a draft, a customer erased or purged (customer_deleted_at), a business whose public
--     pages are closed or that has no quotes (app.quote_link_usable). public.quote_public (the body of 020540),
--     public.quote_public_version (020420: a fingerprint only for an open newest version) and public.quote_public_decide
--     (020485: decides only an open newest version; accepted/declined = already_decided, cancelled/expired = 'closed').
--     The phone is the document phone, else the business's (org_document_settings, organizations).
-- (2) A line priced from a price list that was deleted since is kept in a new version as it was: price, price_list_name
--     kept, price_list_id null; quote_new_version (020540) copies price_list_name, and app.quote_lines_check (020540) lets
--     such a line in only for the copy (app.quote_version_copy names the draft, and its previous quote holds a line of the
--     same deleted list). A person's insert is refused as before (quote_lines:price_list). The screen marks it
--     "המחירון נמחק".
-- (3) public.quote_duplicate (020470) also answers skipped_lines [{id, name, kind}] (additive), so the new draft's page can
--     offer "להוסיף כשורה חופשית" for each left-out item; that is the person's own insert under the normal rules.
-- Safe to run twice.

-- A link of this quote leads somewhere: it was sent (not a draft), its customer was not erased or purged, and the business
-- shows public pages and has quotes (no grants)
create or replace function app.quote_link_usable(p_quote public.quotes) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_quote.id is not null
     and p_quote.status <> 'draft'
     and p_quote.customer_deleted_at is null
     and app.org_public_pages_open(p_quote.organization_id)
     and app.org_has_feature(p_quote.organization_id, 'quotes')
$$;
revoke all on function app.quote_link_usable(public.quotes) from public, anon, authenticated, service_role;

-- The quote is on offer: sent or viewed, not past its validity date in the business's zone (app.quote_link_open's date
-- rule), customer not deleted (no grants)
create or replace function app.quote_offer_open(p_quote public.quotes) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_quote.status in ('sent', 'viewed') and app.quote_link_open(p_quote)
$$;
revoke all on function app.quote_offer_open(public.quotes) from public, anon, authenticated, service_role;

-- (1) the customer's page
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
    'addenda', coalesce((select jsonb_agg(jsonb_build_object('number', a.number_display, 'title', a.title, 'total_agorot', a.total_agorot)
                                          order by a.sent_at, a.number)
                           from public.quotes a
                          where a.organization_id = v_quote.organization_id and a.addendum_of = v_quote.id and a.status = 'accepted'),
                        '[]'::jsonb));
end;
$$;
revoke all on function public.quote_public(text) from public, anon, authenticated;
grant execute on function public.quote_public(text) to service_role;

-- (1) the version reader
create or replace function public.quote_public_version(p_token text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_link app.quote_links;
  v_quote public.quotes;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_link from app.quote_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = v_link.organization_id and q.id = v_link.quote_id;
  -- owner, 19 October 2026: the link of a sent quote never answers not found (app.quote_link_usable)
  if not found or not app.quote_link_usable(v_quote) then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  if v_link.window_started_at > now() - interval '10 minutes' and v_link.window_count > 120 then
    return jsonb_build_object('rate_limited', true);
  end if;
  v_quote := app.quote_shown_version(v_quote);
  if v_quote.customer_deleted_at is not null then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  -- a fingerprint only for an open newest version: only that one is decided
  return jsonb_build_object(
    'number', v_quote.number_display,
    'fingerprint', case when app.quote_offer_open(v_quote) then app.quote_fingerprint(v_quote) end);
end;
$$;
revoke all on function public.quote_public_version(text) from public, anon, authenticated;
grant execute on function public.quote_public_version(text) to service_role;

-- (1) deciding
create or replace function public.quote_public_decide(
  p_token text, p_decision text, p_fingerprint text,
  p_signer_name text default null, p_id_number text default null,
  p_signature_kind text default null, p_signature_image text default null,
  p_wording_version text default null, p_agreed boolean default false,
  p_decline_reason text default null, p_ip text default null, p_user_agent text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_link app.quote_links;
  v_quote public.quotes;
  v_views integer;
  v_tries integer;
  v_shown public.quotes;
  v_name text := nullif(btrim(coalesce(p_signer_name, '')), '');
  v_id text := nullif(regexp_replace(coalesce(p_id_number, ''), '[^0-9]', '', 'g'), '');
  v_reason text := nullif(btrim(coalesce(p_decline_reason, '')), '');
  v_deal_note text;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_link from app.quote_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = v_link.organization_id and q.id = v_link.quote_id;
  -- owner, 19 October 2026: the link of a sent quote never answers not found (app.quote_link_usable)
  if not found or not app.quote_link_usable(v_quote) then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;

  -- counted first, in the link's view window and in a window of its own (10 tries in 10 minutes)
  update app.quote_links l
     set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
         window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end,
         decide_window_started_at = case when l.decide_window_started_at > now() - interval '10 minutes' then l.decide_window_started_at else now() end,
         decide_count = case when l.decide_window_started_at > now() - interval '10 minutes' then l.decide_count + 1 else 1 end
   where l.quote_id = v_link.quote_id
  returning l.window_count, l.decide_count into v_views, v_tries;
  if v_views > 120 or v_tries > 10 then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  -- the version the page shows: the newest that was ever sent (QUO-12, QUO-11 review), locked against a second decision in
  -- parallel; the superseded quote is never decided on
  v_shown := app.quote_shown_version(v_quote);
  select * into v_quote from public.quotes q where q.organization_id = v_shown.organization_id and q.id = v_shown.id for update;
  if v_quote.customer_deleted_at is not null then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  -- re-read after the lock: a newer version sent while this call waited (its send held this quote FOR SHARE) means the page
  -- the customer answered is no longer the one shown
  if (app.quote_shown_version(v_quote)).id is distinct from v_quote.id then
    return jsonb_build_object('status', 'changed');
  end if;
  if v_quote.status in ('accepted', 'rejected') then
    return jsonb_build_object('status', 'already_decided', 'decision', v_quote.status);
  end if;
  -- owner, 19 October 2026: deciding only on an open newest version (a cancelled or expired one shows its status page)
  if not app.quote_offer_open(v_quote) then
    return jsonb_build_object('status', 'closed');
  end if;
  if p_fingerprint is distinct from app.quote_fingerprint(v_quote) then
    return jsonb_build_object('status', 'changed');
  end if;

  if p_decision = 'accepted' then
    if not coalesce(p_agreed, false) or v_name is null or char_length(v_name) not between 2 and 120
       or coalesce(p_wording_version, '') !~ '^[a-z0-9-]{1,40}$'
       or p_signature_kind not in ('drawn', 'typed')
       or (p_signature_kind = 'drawn' and (p_signature_image is null or char_length(p_signature_image) > 300000
                                           or p_signature_image !~ '^data:image/png;base64,[A-Za-z0-9+/]+=*$'))
       or (v_id is not null and not app.valid_israeli_id(v_id)) then
      return jsonb_build_object('status', 'invalid');
    end if;
    insert into public.quote_decisions (organization_id, quote_id, decision, signer_name, signer_id_number, signature_kind,
                                        signature_image, wording_version, content_sha256, ip, user_agent)
    values (v_quote.organization_id, v_quote.id, 'accepted', v_name, v_id, p_signature_kind,
            case when p_signature_kind = 'drawn' then p_signature_image end, p_wording_version, p_fingerprint,
            left(nullif(btrim(coalesce(p_ip, '')), ''), 64), left(nullif(btrim(coalesce(p_user_agent, '')), ''), 500));
  elsif p_decision = 'rejected' then
    if (v_reason is not null and char_length(v_reason) > 1000) or (v_name is not null and char_length(v_name) not between 2 and 120) then
      return jsonb_build_object('status', 'invalid');
    end if;
    insert into public.quote_decisions (organization_id, quote_id, decision, signer_name, content_sha256, ip, user_agent, decline_reason)
    values (v_quote.organization_id, v_quote.id, 'rejected', v_name, p_fingerprint,
            left(nullif(btrim(coalesce(p_ip, '')), ''), 64), left(nullif(btrim(coalesce(p_user_agent, '')), ''), 500), v_reason);
  else
    return jsonb_build_object('status', 'invalid');
  end if;

  update public.quotes q set status = p_decision
   where q.organization_id = v_quote.organization_id and q.id = v_quote.id;

  -- QUO-13: the deal of an accepted quote, by the business's setting. Never fails the decision: a failure is logged and
  -- said in the notice, and the quote page keeps offering the move while the deal is open.
  if p_decision = 'accepted' then
    begin
      v_deal_note := app.quote_accept_deal(v_quote);
    exception when others then
      raise warning 'QUO-13: the deal step of quote % failed: % (%)', v_quote.id, sqlerrm, sqlstate;
      v_deal_note := 'לא הצלחנו לטפל בעסקה של ההצעה. אפשר להעביר אותה לזכייה מדף ההצעה.';
    end;
  end if;

  -- the quote's owner hears of it (kind `quote`, coordinator 18 October 2026): number and title, no amounts
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select v_quote.organization_id, r.user_id, 'quote',
         left(case when p_decision = 'accepted' then 'הצעת מחיר אושרה: ' else 'הצעת מחיר נדחתה: ' end || v_quote.title, 200),
         nullif(concat_ws(' · ', case when v_quote.number_display is not null then 'הצעה ' || v_quote.number_display end, v_deal_note), ''),
         'quote', v_quote.id
    from app.quote_notice_recipients(v_quote) r(user_id);
  return jsonb_build_object('status', p_decision);
end;
$$;
revoke all on function public.quote_public_decide(text, text, text, text, text, text, text, text, boolean, text, text, text) from public, anon, authenticated;
grant execute on function public.quote_public_decide(text, text, text, text, text, text, text, text, boolean, text, text, text) to service_role;

-- (2) the line trigger
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
  elsif tg_op = 'INSERT' and coalesce(current_setting('app.quote_version_copy', true), '') = new.quote_id::text
        and v_quote.previous_id is not null and new.price_list_name is not null
        and exists (select 1 from public.quote_lines pl
                     where pl.organization_id = new.organization_id and pl.quote_id = v_quote.previous_id
                       and pl.price_source = 'price_list' and pl.price_list_id is null
                       and pl.price_list_name = new.price_list_name) then
    -- QUO-12 (owner, 19 October 2026): quote_new_version's copy keeps a line whose price list was deleted as it was, with
    -- the list's name; only when the previous version holds such a line (a person's insert is refused below as before)
    null;
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

-- (2) making a version
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
                                  optional_selected, price_source, price_list_id, price_list_name, currency)
  select l.organization_id, v_new, l.position, l.kind, l.product_id, l.name, l.description, l.quantity,
         l.unit_price_agorot, l.discount_bp, l.discount_agorot, l.vat_exempt, l.billing, l.is_optional,
         l.optional_selected, l.price_source, l.price_list_id, l.price_list_name, l.currency
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

-- (3) duplicating
create or replace function public.quote_duplicate(p_org uuid, p_quote uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
  v_new uuid;
  v_today date;
  v_valid date;
  v_line public.quote_lines;
  v_skipped jsonb := '[]'::jsonb;
  v_skipped_lines jsonb := '[]'::jsonb;
  v_discounts boolean;
  v_dropped boolean := false;
begin
  select * into v_quote from public.quotes q where q.organization_id = p_org and q.id = p_quote;
  if not found or not app.quote_editable(p_org, v_quote.deal_id, v_quote.contact_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.org_has_feature(p_org, 'quotes') then
    raise exception 'quotes are not in this plan' using errcode = 'P0001', hint = 'feature:quotes';
  end if;

  select (now() at time zone app.intake_zone(o.timezone))::date into v_today
    from public.organizations o where o.id = p_org;
  -- the original's validity span, from today
  v_valid := case when v_quote.valid_until is null then null else v_today + (v_quote.valid_until - v_quote.quote_date) end;

  v_discounts := app.org_has_feature(p_org, 'discounts');
  v_dropped := not v_discounts and (v_quote.discount_bp is not null or v_quote.discount_agorot is not null);

  insert into public.quotes (organization_id, title, deal_id, contact_id, company_id, valid_until, prices_include_vat,
                             no_vat_reason, no_vat_note, discount_bp, discount_agorot, notes, terms, currency)
  values (p_org, left('עותק של ' || v_quote.title, 200), v_quote.deal_id, v_quote.contact_id, v_quote.company_id, v_valid,
          v_quote.prices_include_vat, v_quote.no_vat_reason, v_quote.no_vat_note,
          case when v_discounts then v_quote.discount_bp end, case when v_discounts then v_quote.discount_agorot end,
          v_quote.notes, v_quote.terms, v_quote.currency)
  returning id into v_new;
  -- a new quote takes the business's VAT mode; the copy keeps the original's, before any line is added
  update public.quotes q set prices_include_vat = v_quote.prices_include_vat
   where q.organization_id = p_org and q.id = v_new and q.prices_include_vat is distinct from v_quote.prices_include_vat;

  for v_line in
    select * from public.quote_lines l where l.organization_id = p_org and l.quote_id = p_quote order by l.position, l.id
  loop
    begin
      insert into public.quote_lines (organization_id, quote_id, position, kind, product_id, name, description, quantity,
                                      unit_price_agorot, discount_bp, discount_agorot, vat_exempt, billing, is_optional,
                                      optional_selected, price_source, price_list_id, currency)
      values (p_org, v_new, v_line.position, v_line.kind, v_line.product_id, v_line.name, v_line.description, v_line.quantity,
              v_line.unit_price_agorot, v_line.discount_bp, v_line.discount_agorot, v_line.vat_exempt, v_line.billing,
              v_line.is_optional, v_line.optional_selected, v_line.price_source, v_line.price_list_id, v_line.currency);
    exception when sqlstate 'P0001' or integrity_constraint_violation or insufficient_privilege then
      -- the rules refuse this line today (quote_lines_check: P0001; a constraint or a foreign key: class 23; RLS: 42501):
      -- leave it out and name it. Anything else is not a refusal and fails the whole copy.
      v_skipped := v_skipped || to_jsonb(v_line.name);
      -- QUO-15 (owner, 19 October 2026): the screen offers to add an item line as a free line, read again by its id
      v_skipped_lines := v_skipped_lines || jsonb_build_array(jsonb_build_object('id', v_line.id, 'name', v_line.name, 'kind', v_line.kind));
    end;
  end loop;

  insert into public.quote_payment_steps (organization_id, quote_id, position, name, percent_bp, due_date, milestone)
  select s.organization_id, v_new, s.position, s.name, s.percent_bp, s.due_date, s.milestone
    from public.quote_payment_steps s
   where s.organization_id = p_org and s.quote_id = p_quote
   order by s.position, s.id;

  return jsonb_build_object('quote', v_new, 'skipped', v_skipped, 'skipped_lines', v_skipped_lines, 'discount_dropped', v_dropped);
end;
$$;
revoke all on function public.quote_duplicate(uuid, uuid) from public, anon;
grant execute on function public.quote_duplicate(uuid, uuid) to authenticated;
