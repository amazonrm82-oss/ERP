-- QUO-11 review (medium): a closed newer version must not bring the superseded quote back on the customer's old link.
--
-- Before: app.quote_shown_version (and quote_public's chain walk) took the newest version that was OPEN with a live link of
-- its own, so when v2 was cancelled or expired the old link fell back to v1 and QUO-09 let the customer accept v1.
-- Now: the link shows the newest version that was ever SENT (sent_at is not null), never an older one. It is shown (with
-- `replaced`, as before) while it is open and, when it is not the link's own quote, while it has a working link of its own
-- (app.quote_link_shows); otherwise the link answers like a closed quote: not found. So a cancelled or expired v2, and a v2
-- whose link was turned off or not made yet, close v1's link instead of showing v1 again. A decided newest version is shown
-- as decided, as today. A version that was never sent (a draft) changes nothing.
-- * public.quote_public (from the 020390 body, QUO-10), public.quote_public_version and public.quote_public_decide all
--   use app.quote_shown_version + app.quote_link_shows (one rule, no copy of the chain walk left in quote_public).
-- * app.quotes_version_guard (from the 020345 body) refuses, for every writer, accepting or declining a quote that has a
--   sent newer version (hint quote:superseded), and sending a version whose previous quote was already accepted or
--   declined (hint quote_version:previous_decided; the previous quote is taken FOR SHARE). quote_new_version from v1 was
--   already refused (quote_version:exists; from a decided quote quote_version:closed). quote_public_decide re-reads the
--   shown version after its FOR UPDATE and answers 'changed' when a newer version was sent meanwhile.
-- Known, left as they are (re-review notes, low): a superseded v1 stays 'sent' in the lists until it expires or is
-- cancelled; and v1's own link closes when v1's validity date passes (app.quote_link_open on the link's quote), even while
-- a newer version is still open.

-- ----------------------------------------------------------------------------
-- The version a link shows
-- ----------------------------------------------------------------------------
create or replace function app.quote_shown_version(p_quote public.quotes) returns public.quotes
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_shown public.quotes := p_quote;
  v_next public.quotes := p_quote;
  v_steps integer := 0;
begin
  -- the newest version in the chain that was ever sent; the caller decides whether it is open
  loop
    select * into v_next from public.quotes q
     where q.organization_id = v_next.organization_id and q.previous_id = v_next.id;
    exit when not found;
    v_steps := v_steps + 1;
    exit when v_steps > 100;
    if v_next.sent_at is not null then
      v_shown := v_next;
    end if;
  end loop;
  return v_shown;
end;
$$;
revoke all on function app.quote_shown_version(public.quotes) from public, anon, authenticated, service_role;

-- Whether a link made for p_link_quote may show p_shown (= app.quote_shown_version(p_link_quote)): open, and a newer version
-- only while it has a working link of its own (turning that link off hides it everywhere)
create or replace function app.quote_link_shows(p_link_quote public.quotes, p_shown public.quotes) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app.quote_link_open(p_shown)
     and (p_shown.id = p_link_quote.id
          or exists (select 1 from app.quote_links l
                      where l.organization_id = p_shown.organization_id and l.quote_id = p_shown.id and l.token_hash is not null))
$$;
revoke all on function app.quote_link_shows(public.quotes, public.quotes) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- A superseded quote is never decided
-- ----------------------------------------------------------------------------
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
    if v_previous_status in ('accepted', 'rejected') then
      raise exception 'the previous version was already decided' using errcode = 'P0001', hint = 'quote_version:previous_decided';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.quotes_version_guard() from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The customer's page (the body of 020390, QUO-10, with app.quote_shown_version and app.quote_link_shows for the chain walk)
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
    'replaced', case when v_opened.id is not null then jsonb_build_object('number', v_opened.number_display) end);
end;
$$;
revoke all on function public.quote_public(text) from public, anon, authenticated;
grant execute on function public.quote_public(text) to service_role;

-- ----------------------------------------------------------------------------
-- The decision panel's version reader and the decision (bodies of 020370 with the closed-version check)
-- ----------------------------------------------------------------------------
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
  if not found or not app.quote_link_open(v_quote)
     or not app.org_public_pages_open(v_quote.organization_id)
     or not app.org_has_feature(v_quote.organization_id, 'quotes') then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  if v_link.window_started_at > now() - interval '10 minutes' and v_link.window_count > 120 then
    return jsonb_build_object('rate_limited', true);
  end if;
  if not app.quote_link_shows(v_quote, app.quote_shown_version(v_quote)) then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  v_quote := app.quote_shown_version(v_quote);
  return jsonb_build_object(
    'number', v_quote.number_display,
    'fingerprint', case when v_quote.status in ('sent', 'viewed') then app.quote_fingerprint(v_quote) end);
end;
$$;
revoke all on function public.quote_public_version(text) from public, anon, authenticated;
grant execute on function public.quote_public_version(text) to service_role;

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

  -- the version the page shows (QUO-12), locked against a second decision in parallel; a newer version that was sent and is
  -- now closed closes the old link too (QUO-11 review): the superseded quote is never decided on
  v_shown := app.quote_shown_version(v_quote);
  if not app.quote_link_shows(v_quote, v_shown) then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = v_shown.organization_id and q.id = v_shown.id for update;
  if not app.quote_link_open(v_quote) then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  -- re-read after the lock: a newer version sent while this call waited (its send held this quote FOR SHARE) means the page
  -- the customer answered is no longer the one shown
  if (app.quote_shown_version(v_quote)).id is distinct from v_quote.id then
    return jsonb_build_object('status', 'changed');
  end if;
  if v_quote.status not in ('sent', 'viewed') then
    return jsonb_build_object('status', 'already_decided', 'decision', v_quote.status);
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

  -- the quote's owner hears of it (kind `quote`, coordinator 18 October 2026): number and title, no amounts
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select v_quote.organization_id, v_quote.owner_id, 'quote',
         left(case when p_decision = 'accepted' then 'הצעת מחיר אושרה: ' else 'הצעת מחיר נדחתה: ' end || v_quote.title, 200),
         case when v_quote.number_display is not null then 'הצעה ' || v_quote.number_display end,
         'quote', v_quote.id
   where v_quote.owner_id is not null
     and exists (select 1 from public.memberships m
                  where m.organization_id = v_quote.organization_id and m.user_id = v_quote.owner_id and m.status = 'active');
  return jsonb_build_object('status', p_decision);
end;
$$;
revoke all on function public.quote_public_decide(text, text, text, text, text, text, text, text, boolean, text, text, text) from public, anon, authenticated;
grant execute on function public.quote_public_decide(text, text, text, text, text, text, text, text, boolean, text, text, text) to service_role;
