-- QUO-08 (first part) and the link of QUO-07's sending: the customer's page of a sent quote, through a secret link.
--
-- The approved pattern for public secret-link pages (owner, 8 October 2026; CLAUDE.md hard rule 5): the page's server
-- route calls one security definer function, granted to service_role only, which checks the token and answers only
-- what the page shows. No table is reached directly with the service key.
--
-- * app.quote_links: one link per quote (no API access). Only the SHA-256 of the token is kept (as CAL-07's calendar
--   feed): the link is shown once when it is made; a new link replaces the old one, which stops working at once;
--   turning it off clears the hash. Nothing is ever deleted (the row goes with its quote by cascade).
-- * public.quote_link_create(org, quote) / quote_link_revoke(org, quote) / quote_link_status(org, quote): security
--   definer, for whoever may edit the quote's deal or contact (app.quote_editable), in a business with the 'quotes'
--   flag. Only a quote that was sent and is still open gets a link (hints quote:not_sent, quote:closed); a quote whose
--   customer was deleted gets none. Making and turning off a link is written to the audit log (no token, no hash).
-- * public.quote_public(token): service_role only. Not found (P0002) for an unknown or turned-off token, a draft, a
--   cancelled or expired quote (status, or valid_until before the business's today), a quote whose customer was
--   deleted, a business without the flag, and a business whose public pages are closed (app.org_public_pages_open).
--   Views: at most 120 per link in 10 minutes, counted on the link (no IP, no visitor id); past that the answer is
--   {"rate_limited": true}. The answer holds only what the customer's page shows: the quote as stored when it was
--   sent (number, dates, the stored rate and totals, notes and terms), the names as printed, its lines without ids,
--   products or price sources, the business as QUO-05's design shows it, and the brand.
--
-- Every statement is safe to run twice. No drops, no row removal.

create table if not exists app.quote_links (
  quote_id           uuid primary key,
  organization_id    uuid not null,
  -- hex SHA-256 of the token; null = turned off
  token_hash         text unique,
  created_by         uuid,
  created_at         timestamptz,
  window_started_at  timestamptz,
  window_count       integer not null default 0,
  unique (organization_id, quote_id),
  constraint quote_links_quote_fk foreign key (organization_id, quote_id)
    references public.quotes (organization_id, id) on delete cascade
);
alter table app.quote_links enable row level security;
revoke all on app.quote_links from public, anon, authenticated, service_role;

-- Whether a quote may have a customer link now: sent (not a draft), not cancelled or expired, its customer not deleted,
-- and its validity not past in the business's time zone
create or replace function app.quote_link_open(p_quote public.quotes) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_quote.id is not null
     and p_quote.status not in ('draft', 'cancelled', 'expired')
     and p_quote.customer_deleted_at is null
     and (p_quote.valid_until is null
          or p_quote.valid_until >= (select (now() at time zone app.intake_zone(o.timezone))::date
                                       from public.organizations o where o.id = p_quote.organization_id))
$$;
revoke all on function app.quote_link_open(public.quotes) from public, anon, authenticated, service_role;

-- The caller may manage the quote's link: they may edit its deal or contact, in a business with quotes
create or replace function app.quote_link_quote(p_org uuid, p_quote uuid) returns public.quotes
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
begin
  select * into v_quote from public.quotes q where q.organization_id = p_org and q.id = p_quote;
  if not found or not app.quote_editable(p_org, v_quote.deal_id, v_quote.contact_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.org_has_feature(p_org, 'quotes') then
    raise exception 'quotes are not in this plan' using errcode = 'P0001', hint = 'feature:quotes';
  end if;
  return v_quote;
end;
$$;
revoke all on function app.quote_link_quote(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.quote_link_create(p_org uuid, p_quote uuid) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
  v_token text;
begin
  v_quote := app.quote_link_quote(p_org, p_quote);
  if v_quote.status = 'draft' then
    raise exception 'only a sent quote has a link' using errcode = 'P0001', hint = 'quote:not_sent';
  end if;
  if not app.quote_link_open(v_quote) then
    raise exception 'the quote is no longer open' using errcode = 'P0001', hint = 'quote:closed';
  end if;

  -- 48 random bytes from three UUIDs, base64url: 64 characters
  v_token := translate(
    encode(decode(replace(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'), 'base64'),
    E'+/=\n', '-_');

  insert into app.quote_links as l (quote_id, organization_id, token_hash, created_by, created_at, window_started_at, window_count)
  values (p_quote, p_org, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), auth.uid(), now(), null, 0)
  on conflict (quote_id) do update
    set token_hash = excluded.token_hash,
        created_by = excluded.created_by,
        created_at = excluded.created_at,
        window_started_at = null,
        window_count = 0;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'quote_link', 'quotes', p_quote, jsonb_build_object('link', 'created'));
  return v_token;
end;
$$;
revoke all on function public.quote_link_create(uuid, uuid) from public, anon;
grant execute on function public.quote_link_create(uuid, uuid) to authenticated;

-- Turning the link off only lessens access, but it is still for those who manage the quote
create or replace function public.quote_link_revoke(p_org uuid, p_quote uuid) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform app.quote_link_quote(p_org, p_quote);
  update app.quote_links l
     set token_hash = null, created_at = null, window_started_at = null, window_count = 0
   where l.organization_id = p_org and l.quote_id = p_quote and l.token_hash is not null;
  get diagnostics v_count = row_count;
  if v_count > 0 then
    insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
    values (p_org, auth.uid(), 'quote_link', 'quotes', p_quote, jsonb_build_object('link', 'revoked'));
  end if;
  return v_count > 0;
end;
$$;
revoke all on function public.quote_link_revoke(uuid, uuid) from public, anon;
grant execute on function public.quote_link_revoke(uuid, uuid) to authenticated;

-- Whether the quote has a working link, and since when (never the hash)
create or replace function public.quote_link_status(p_org uuid, p_quote uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
  v_created timestamptz;
begin
  v_quote := app.quote_link_quote(p_org, p_quote);
  select l.created_at into v_created from app.quote_links l
   where l.organization_id = p_org and l.quote_id = p_quote and l.token_hash is not null;
  return jsonb_build_object('active', v_created is not null and app.quote_link_open(v_quote), 'created_at', v_created);
end;
$$;
revoke all on function public.quote_link_status(uuid, uuid) from public, anon;
grant execute on function public.quote_link_status(uuid, uuid) to authenticated;

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
    'built_with', v_built_with);
end;
$$;
revoke all on function public.quote_public(text) from public, anon, authenticated;
grant execute on function public.quote_public(text) to service_role;
