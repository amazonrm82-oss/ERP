-- =============================================================================
-- QUO-11: cancelling a quote the customer already accepted (owner, 19 October 2026, answer (ב))
-- =============================================================================
-- Owners and admins only, with a reason; written to the audit log and the timeline; the customer's link says "cancelled";
-- the quote's people hear of it. public.quote_cancel is unchanged (sent, viewed or expired; an accepted quote still answers
-- quote_cancel:accepted there): an accepted quote is cancelled only through public.quote_cancel_accepted.
--
-- * quotes.cancelled_from ('accepted' or null) and quotes.cancel_reason (1..500 characters): server only (quotes has
--   column grants and these get none); a check keeps cancelled_from on cancelled quotes only. The quotes audit trigger logs
--   the status, cancelled_from and the reason with the actor (that is the audit entry).
-- * public.quote_cancel_accepted(org, quote, reason) (definer): app.is_admin and a writable business, the quotes flag, an
--   accepted quote, a non-empty reason (hints quote_cancel:reason, quote_cancel:not_accepted). The deal is not touched: a deal
--   the quote won stays won (a person moves it if needed). Notifies app.quote_notice_recipients except the actor (kind
--   quote; title and number, the reason in the body).
-- * app.quote_timeline_entry (the body of 020415) adds " · סיבה: <reason>" to the "בוטלה על ידי …" entry.
-- * public.quote_public (the body of 020430): when the link's quote, or the newest sent version it would show, is an
--   accepted quote that was cancelled, the page answers {cancelled: {number, title, business, logo, color}} after the
--   view limit: no prices, lines, schedule or decision. Every other cancelled quote, and one whose customer was purged
--   (customer_deleted_at, as app.quote_link_open), still answers not found.
-- Additive; safe to run twice.

alter table public.quotes add column if not exists cancelled_from text;
alter table public.quotes add column if not exists cancel_reason text;
alter table public.quotes drop constraint if exists quotes_cancelled_from_check;
alter table public.quotes add constraint quotes_cancelled_from_check
  check (cancelled_from is null or (cancelled_from = 'accepted' and status = 'cancelled'));
alter table public.quotes drop constraint if exists quotes_cancel_reason_check;
alter table public.quotes add constraint quotes_cancel_reason_check
  check (cancel_reason is null or char_length(btrim(cancel_reason)) between 1 and 500);

-- ----------------------------------------------------------------------------
-- Cancelling an accepted quote
-- ----------------------------------------------------------------------------
create or replace function public.quote_cancel_accepted(p_org uuid, p_quote uuid, p_reason text) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into v_quote from public.quotes q where q.organization_id = p_org and q.id = p_quote for update;
  if not found or not app.is_admin(p_org) or not app.org_writable(p_org) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.org_has_feature(p_org, 'quotes') then
    raise exception 'quotes are not in this plan' using errcode = 'P0001', hint = 'feature:quotes';
  end if;
  if v_quote.status <> 'accepted' then
    raise exception 'only an accepted quote is cancelled here' using errcode = 'P0001', hint = 'quote_cancel:not_accepted';
  end if;
  if v_reason is null or char_length(v_reason) > 500 then
    raise exception 'a reason is required' using errcode = 'P0001', hint = 'quote_cancel:reason';
  end if;

  update public.quotes q set status = 'cancelled', cancelled_from = 'accepted', cancel_reason = v_reason
   where q.organization_id = p_org and q.id = p_quote;

  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select v_quote.organization_id, r.user_id, 'quote',
         left('הצעת מחיר שאושרה בוטלה: ' || v_quote.title, 200),
         left(concat_ws(' · ', case when v_quote.number_display is not null then 'הצעה ' || v_quote.number_display end,
                        'סיבה: ' || v_reason), 600),
         'quote', v_quote.id
    from app.quote_notice_recipients(v_quote) r(user_id)
   where r.user_id is distinct from auth.uid();
end;
$$;
revoke all on function public.quote_cancel_accepted(uuid, uuid, text) from public, anon;
grant execute on function public.quote_cancel_accepted(uuid, uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- The timeline entry (the body of 020415; the reason is new)
-- ----------------------------------------------------------------------------
create or replace function app.quote_timeline_entry() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_person uuid := auth.uid();
  v_type text;
  v_by text;
begin
  if new.status is not distinct from old.status or (new.deal_id is null and new.contact_id is null) then
    return null;
  end if;
  v_kind := case new.status
              when 'sent' then 'quote_sent' when 'accepted' then 'quote_accepted' when 'rejected' then 'quote_rejected'
              when 'expired' then 'quote_expired' when 'cancelled' then 'quote_cancelled' end;
  if v_kind is null then
    return null;
  end if;
  -- only "sent" is a person's contact with the customer; everything else is a system entry with no author
  v_type := case when v_kind = 'quote_sent' and v_person is not null then 'note' else 'system' end;
  if v_kind = 'quote_cancelled' and v_person is not null then
    select nullif(btrim(p.full_name), '') into v_by from public.profiles p where p.id = v_person;
  end if;

  insert into public.activities (organization_id, type, deal_id, contact_id, body, metadata, created_by)
  values (new.organization_id, v_type, new.deal_id, new.contact_id,
          'הצעת מחיר' || coalesce(' ' || new.number_display, '')
            || case v_kind when 'quote_sent' then ' נשלחה' when 'quote_accepted' then ' אושרה' when 'quote_rejected' then ' נדחתה'
                           when 'quote_expired' then ' פג תוקפה' else ' בוטלה' end
            || coalesce(' על ידי ' || left(v_by, 120), '')
            -- QUO-11 (owner, 19 October 2026): an accepted quote is cancelled with a reason
            || case when v_kind = 'quote_cancelled' and new.cancel_reason is not null then ' · סיבה: ' || new.cancel_reason else '' end,
          jsonb_build_object('kind', v_kind, 'quote_id', new.id, 'number', new.number_display),
          case when v_type = 'note' then v_person end);
  return null;
end;
$$;
revoke all on function app.quote_timeline_entry() from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The customer's page (the body of 020430; the cancelled answer is new)
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
