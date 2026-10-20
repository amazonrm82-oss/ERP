-- =============================================================================
-- ORD-05: the customer's order confirmation through a secret link (owner, 20 October 2026, DECISIONS.md "הזמנות: קישור
-- ללקוח לאישור ההזמנה", answer (א))
-- =============================================================================
-- The approved pattern for public secret-link pages (CLAUDE.md hard rule 5), as QUO-08 / QUO-09 for quotes: the page's
-- server route calls one security definer function granted to service_role only, which checks the token and answers only
-- what the page shows; no table is reached directly with the service key.
--
-- * app.order_links: one link per order (no API access, no grants). Only the SHA-256 of the token is kept; the link is shown
--   once when it is made; a new link replaces the old one; turning it off clears the hash. The row goes with its order.
-- * public.order_link_create(org, order) / order_link_revoke / order_link_status: security definer, for whoever may edit the
--   order (app.order_editable) in a business with the `orders` flag. Only a numbered order gets a link (hint
--   order_link:draft), not a cancelled one (order_link:cancelled), not one whose customer was deleted
--   (order_link:customer_deleted). Making and turning off a link is audited (no token, no hash).
-- * The one rule for a sent link (as 020550 for quotes, app.order_link_usable): not found (P0002) only for an unknown or
--   revoked token, a draft, an erased or purged customer (customer_deleted_at), a business whose public pages are closed or
--   that has no `orders` flag. Every other numbered order shows its state: a cancelled one answers
--   {status_page: {state, number, business, logo, color, phone}} without prices or lines; the others the full confirmation.
-- * public.order_public(token, ip_hash): service_role only. Views: 120 per link in 10 minutes (counted on the link), and,
--   with the server's keyed IP hash (FXS-11, src/lib/keyed-ip-hash.ts, scope "order"), 60 per sender in 10 minutes in
--   app.order_link_view_counts (1,024 reused buckets per order, no hash stored; the sender is scoped to the order by
--   app.order_link_sender). Past either: {"rate_limited": true}. The answer holds only what the confirmation shows: the
--   order as numbered (number, dates, delivery date and address, notes, VAT, the stored totals), the customer's name as
--   printed, the lines without ids, products or price sources, the payment schedule with each step's share (ORD-04), the
--   business as QUO-05's design shows it, the brand, and the customer's answer (decision and time only). No ids.
--   'fingerprint' (SHA-256 of what is shown, app.order_fingerprint) is given only while the order waits for an answer.
-- * public.order_decisions (as QUO-09's quote_decisions): one answer per order, written only by public.order_public_decide,
--   read only by owners and admins (RLS), not audited. An approval keeps the signer's full name, an optional Israeli ID, the
--   signature (drawn PNG or typed name), the wording version (DRAFT until the lawyer edits it), the fingerprint of what was
--   shown, the full IP and browser; a refusal an optional reason. A privacy erasure empties the personal fields
--   (app.audit_erase_core, the body of 020620).
-- * public.order_public_decide(token, ...): service_role only; checks the token like order_public and does only this. Only a
--   numbered order in state 'new' with no answer yet is decided (else 'closed' / 'already_decided'); the page's fingerprint
--   must match (else 'changed': the delivery details or notes changed in between). 10 tries per 10 minutes on the link, plus
--   the view window; every outcome is an answer, never an error. The order's status is not changed by the answer (staff move
--   it, ORD-02); the order's active owner, else the active owners and admins, get a `system` notice (number only).
-- Every statement is safe to run twice. No drops, no row removal.

create table if not exists app.order_links (
  order_id                  uuid primary key,
  organization_id           uuid not null,
  -- hex SHA-256 of the token; null = turned off
  token_hash                text unique,
  created_by                uuid,
  created_at                timestamptz,
  window_started_at         timestamptz,
  window_count              integer not null default 0,
  decide_window_started_at  timestamptz,
  decide_count              integer not null default 0,
  unique (organization_id, order_id),
  constraint order_links_order_fk foreign key (organization_id, order_id)
    references public.orders (organization_id, id) on delete cascade
);
alter table app.order_links enable row level security;
revoke all on app.order_links from public, anon, authenticated, service_role;

-- Views per sender: a fixed set of counters per order (1,024 buckets picked by the scoped keyed IP hash), each counting its
-- 10-minute window and reused by the next one (an update, never a delete). No hash is stored.
create table if not exists app.order_link_view_counts (
  order_id      uuid not null references public.orders (id) on delete cascade,
  bucket        integer not null check (bucket between 0 and 1023),
  window_start  timestamptz not null,
  views         integer not null,
  primary key (order_id, bucket)
);
alter table app.order_link_view_counts enable row level security;
revoke all on app.order_link_view_counts from public, anon, authenticated, service_role;

-- The sender, scoped to one order (as app.business_card_sender): nothing matches across orders or businesses
create or replace function app.order_link_sender(p_order uuid, p_hash text) returns text
language sql immutable
set search_path = ''
as $$
  select case when p_hash is null or p_order is null then null
              else encode(sha256(convert_to('order:' || p_order::text || ':' || p_hash, 'UTF8')), 'hex') end
$$;
revoke all on function app.order_link_sender(uuid, text) from public, anon, authenticated, service_role;

-- The one rule for a sent link: everything but this shows the order's state
create or replace function app.order_link_usable(p_order public.orders) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_order.id is not null
     and p_order.status <> 'draft'
     and p_order.customer_deleted_at is null
     and app.org_public_pages_open(p_order.organization_id)
     and app.org_has_feature(p_order.organization_id, 'orders')
$$;
revoke all on function app.order_link_usable(public.orders) from public, anon, authenticated, service_role;

-- The caller may manage the order's link: they may edit the order, in a business with orders
create or replace function app.order_link_order(p_org uuid, p_order uuid) returns public.orders
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  select * into v_order from public.orders o where o.organization_id = p_org and o.id = p_order;
  if not found or not app.order_editable(p_org, v_order.deal_id, v_order.contact_id, v_order.company_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.org_has_feature(p_org, 'orders') then
    raise exception 'orders are not in this plan' using errcode = 'P0001', hint = 'feature:orders';
  end if;
  return v_order;
end;
$$;
revoke all on function app.order_link_order(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.order_link_create(p_org uuid, p_order uuid) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_token text;
begin
  v_order := app.order_link_order(p_org, p_order);
  if v_order.status = 'draft' then
    raise exception 'only a numbered order has a link' using errcode = 'P0001', hint = 'order_link:draft';
  end if;
  if v_order.status = 'cancelled' then
    raise exception 'the order was cancelled' using errcode = 'P0001', hint = 'order_link:cancelled';
  end if;
  if v_order.customer_deleted_at is not null then
    raise exception 'the customer of the order was deleted' using errcode = 'P0001', hint = 'order_link:customer_deleted';
  end if;

  -- 48 random bytes from three UUIDs, base64url: 64 characters
  v_token := translate(
    encode(decode(replace(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'), 'base64'),
    E'+/=\n', '-_');

  insert into app.order_links as l (order_id, organization_id, token_hash, created_by, created_at, window_started_at, window_count)
  values (p_order, p_org, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), auth.uid(), now(), null, 0)
  on conflict (order_id) do update
    set token_hash = excluded.token_hash,
        created_by = excluded.created_by,
        created_at = excluded.created_at,
        window_started_at = null,
        window_count = 0,
        decide_window_started_at = null,
        decide_count = 0;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'order_link', 'orders', p_order, jsonb_build_object('link', 'created'));
  return v_token;
end;
$$;
revoke all on function public.order_link_create(uuid, uuid) from public, anon;
grant execute on function public.order_link_create(uuid, uuid) to authenticated;

-- Turning the link off only lessens access, but it is still for those who manage the order
create or replace function public.order_link_revoke(p_org uuid, p_order uuid) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform app.order_link_order(p_org, p_order);
  update app.order_links l
     set token_hash = null, created_at = null, window_started_at = null, window_count = 0
   where l.organization_id = p_org and l.order_id = p_order and l.token_hash is not null;
  get diagnostics v_count = row_count;
  if v_count > 0 then
    insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
    values (p_org, auth.uid(), 'order_link', 'orders', p_order, jsonb_build_object('link', 'revoked'));
  end if;
  return v_count > 0;
end;
$$;
revoke all on function public.order_link_revoke(uuid, uuid) from public, anon;
grant execute on function public.order_link_revoke(uuid, uuid) to authenticated;

-- Whether the order has a working link, and since when (never the hash)
create or replace function public.order_link_status(p_org uuid, p_order uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_created timestamptz;
begin
  v_order := app.order_link_order(p_org, p_order);
  select l.created_at into v_created from app.order_links l
   where l.organization_id = p_org and l.order_id = p_order and l.token_hash is not null;
  return jsonb_build_object('active', v_created is not null and app.order_link_usable(v_order), 'created_at', v_created);
end;
$$;
revoke all on function public.order_link_status(uuid, uuid) from public, anon;
grant execute on function public.order_link_status(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The customer's answer
-- ----------------------------------------------------------------------------
create table if not exists public.order_decisions (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  order_id           uuid not null,
  decision           text not null check (decision in ('accepted', 'rejected')),
  decided_at         timestamptz not null default now(),
  signer_name        text check (signer_name is null or char_length(btrim(signer_name)) between 2 and 120),
  signer_id_number   text check (signer_id_number is null or app.valid_israeli_id(signer_id_number)),
  signature_kind     text check (signature_kind in ('drawn', 'typed')),
  signature_image    text check (signature_image is null
                                 or (char_length(signature_image) <= 300000 and signature_image ~ '^data:image/png;base64,[A-Za-z0-9+/]+=*$')),
  wording_version    text check (wording_version is null or char_length(wording_version) <= 40),
  content_sha256     text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  ip                 text check (ip is null or char_length(ip) <= 64),
  user_agent         text check (user_agent is null or char_length(user_agent) <= 500),
  decline_reason     text check (decline_reason is null or char_length(decline_reason) <= 1000),
  -- set when a privacy erasure emptied the personal fields (the shape below no longer holds then)
  erased_at          timestamptz,
  created_at         timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, order_id),
  constraint order_decisions_order_fk foreign key (organization_id, order_id)
    references public.orders (organization_id, id) on delete cascade,
  -- an approval carries its signature; a refusal none
  constraint order_decisions_shape check (
    erased_at is not null
    or (decision = 'accepted' and signer_name is not null and signature_kind is not null and wording_version is not null
       and (signature_kind = 'typed' or signature_image is not null) and decline_reason is null)
    or (decision = 'rejected' and signature_kind is null and signature_image is null and signer_id_number is null))
);

alter table public.order_decisions enable row level security;
revoke all on public.order_decisions from anon, authenticated;
grant select on public.order_decisions to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'order_decisions' and policyname = 'order_decisions_select') then
    -- as quote_decisions (owner, 18 October 2026): shown only to owners and admins
    create policy order_decisions_select on public.order_decisions for select to authenticated
      using (app.is_admin(organization_id));
  end if;
end;
$$;

-- The SHA-256 of what the customer is shown: the order's stored fields, its lines and its payment schedule
create or replace function app.order_fingerprint(p_order public.orders) returns text
language sql stable security definer
set search_path = ''
as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'number', p_order.number_display,
    'customer', p_order.customer_name,
    'dates', jsonb_build_array(p_order.order_date, p_order.delivery_date),
    'shipping', p_order.shipping_address,
    'notes', p_order.notes,
    'vat', jsonb_build_array(p_order.prices_include_vat, p_order.no_vat_reason, p_order.no_vat_note, p_order.vat_rate_bp),
    'discount', jsonb_build_array(p_order.discount_bp, p_order.discount_agorot),
    'totals', jsonb_build_array(p_order.subtotal_agorot, p_order.discount_total_agorot, p_order.net_total_agorot,
                                p_order.vat_agorot, p_order.total_agorot, p_order.currency),
    'lines', coalesce((select jsonb_agg(jsonb_build_array(l.position, l.kind, l.name, l.description, l.unit_name, l.quantity,
                                                          l.unit_price_agorot, l.discount_bp, l.discount_agorot, l.vat_exempt,
                                                          l.billing, l.total_agorot)
                                      order by l.position, l.id)
                         from public.order_lines l
                        where l.organization_id = p_order.organization_id and l.order_id = p_order.id), '[]'::jsonb),
    'schedule', coalesce((select jsonb_agg(jsonb_build_array(s.position, s.name, s.percent_bp, s.due_date, s.milestone)
                                         order by s.position, s.id)
                            from public.order_payment_steps s
                           where s.organization_id = p_order.organization_id and s.order_id = p_order.id), '[]'::jsonb)
  )::text, 'UTF8')), 'hex');
$$;
revoke all on function app.order_fingerprint(public.orders) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The customer's page
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
      'accent_color', v_design.accent_color),
    'brand', jsonb_build_object('logo', case when v_show_logo then v_org.logo_path end, 'color', v_org.brand_color),
    'built_with', v_built_with,
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
-- Deciding
-- ----------------------------------------------------------------------------
create or replace function public.order_public_decide(
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
  v_link app.order_links;
  v_order public.orders;
  v_views integer;
  v_tries integer;
  v_name text := nullif(btrim(coalesce(p_signer_name, '')), '');
  v_id text := nullif(regexp_replace(coalesce(p_id_number, ''), '[^0-9]', '', 'g'), '');
  v_reason text := nullif(btrim(coalesce(p_decline_reason, '')), '');
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

  -- counted first, in the link's view window and in a window of its own (10 tries in 10 minutes)
  update app.order_links l
     set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
         window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end,
         decide_window_started_at = case when l.decide_window_started_at > now() - interval '10 minutes' then l.decide_window_started_at else now() end,
         decide_count = case when l.decide_window_started_at > now() - interval '10 minutes' then l.decide_count + 1 else 1 end
   where l.order_id = v_link.order_id
  returning l.window_count, l.decide_count into v_views, v_tries;
  if v_views > 120 or v_tries > 10 then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  -- locked against a second answer, and against a change of the order, in parallel
  select * into v_order from public.orders o where o.organization_id = v_order.organization_id and o.id = v_order.id for update;
  if exists (select 1 from public.order_decisions d where d.organization_id = v_order.organization_id and d.order_id = v_order.id) then
    return jsonb_build_object('status', 'already_decided');
  end if;
  if v_order.status <> 'new' then
    return jsonb_build_object('status', 'closed');
  end if;
  if p_fingerprint is distinct from app.order_fingerprint(v_order) then
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
    insert into public.order_decisions (organization_id, order_id, decision, signer_name, signer_id_number, signature_kind,
                                        signature_image, wording_version, content_sha256, ip, user_agent)
    values (v_order.organization_id, v_order.id, 'accepted', v_name, v_id, p_signature_kind,
            case when p_signature_kind = 'drawn' then p_signature_image end, p_wording_version, p_fingerprint,
            left(nullif(btrim(coalesce(p_ip, '')), ''), 64), left(nullif(btrim(coalesce(p_user_agent, '')), ''), 500));
  elsif p_decision = 'rejected' then
    if (v_reason is not null and char_length(v_reason) > 1000) or (v_name is not null and char_length(v_name) not between 2 and 120) then
      return jsonb_build_object('status', 'invalid');
    end if;
    insert into public.order_decisions (organization_id, order_id, decision, signer_name, content_sha256, ip, user_agent, decline_reason)
    values (v_order.organization_id, v_order.id, 'rejected', v_name, p_fingerprint,
            left(nullif(btrim(coalesce(p_ip, '')), ''), 64), left(nullif(btrim(coalesce(p_user_agent, '')), ''), 500), v_reason);
  else
    return jsonb_build_object('status', 'invalid');
  end if;

  -- the order's active owner (not a viewer), else the active owners and admins: the number only, no amounts
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select v_order.organization_id, r.user_id, 'system',
         case when p_decision = 'accepted' then 'הלקוח אישר את ההזמנה בקישור' else 'הלקוח דחה את ההזמנה בקישור' end,
         case when v_order.number_display is not null then 'הזמנה ' || v_order.number_display end,
         'order', v_order.id
    from (select m.user_id from public.memberships m
           where m.organization_id = v_order.organization_id and m.user_id = v_order.owner_id
             and m.status = 'active' and m.role <> 'viewer'
          union
          select m.user_id from public.memberships m
           where m.organization_id = v_order.organization_id and m.status = 'active' and m.role in ('owner', 'admin')
             and not exists (select 1 from public.memberships o
                              where o.organization_id = v_order.organization_id and o.user_id = v_order.owner_id
                                and o.status = 'active' and o.role <> 'viewer')) r;
  return jsonb_build_object('status', p_decision);
end;
$$;
revoke all on function public.order_public_decide(text, text, text, text, text, text, text, text, boolean, text, text, text) from public, anon, authenticated;
grant execute on function public.order_public_decide(text, text, text, text, text, text, text, text, boolean, text, text, text) to service_role;

-- ----------------------------------------------------------------------------
-- Privacy erasure: 020620's app.audit_erase_core, plus the answers on the erased orders
-- ----------------------------------------------------------------------------
create or replace function app.audit_erase_core(p_org uuid, p_type text, p_id uuid, p_actor uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  v_col text := case p_type when 'leads' then 'lead_id' when 'contacts' then 'contact_id'
                            when 'companies' then 'company_id' when 'deals' then 'deal_id' end;
  v_exists boolean;
  v_row jsonb;
  v_child record;
  v_children text[] := '{}';
  v_count integer;
  v_more integer;
begin
  if v_col is null then
    raise exception 'unknown record type' using errcode = '22023';
  end if;
  execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)', p_type)
    into v_exists using p_org, p_id;
  if v_exists then
    raise exception 'delete the record permanently first' using errcode = 'P0001', hint = 'erase:exists';
  end if;

  -- the deleted row, for the form submissions below (before it is erased)
  select a.changes into v_row from public.audit_log a
   where a.organization_id = p_org and a.entity_type = p_type and a.entity_id = p_id and a.action = 'delete'
   order by a.id desc limit 1;

  -- tasks, files, notes and deal lines (DLI-01) that were linked to it and no longer exist: by the
  -- ids in their entries, and for notes by every record they were ever linked to
  for v_child in
    select distinct a.entity_type, a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type in ('tasks', 'files', 'activities', 'deal_lines', 'quotes', 'orders') and a.entity_id is not null
       and (a.changes ->> v_col = p_id::text or a.changes -> v_col ->> 'old' = p_id::text or a.changes -> v_col ->> 'new' = p_id::text)
    union
    select 'activities', l.activity_id from app.activity_audit_links l
     where l.organization_id = p_org and l.record_id = p_id
  loop
    execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)', v_child.entity_type)
      into v_exists using p_org, v_child.entity_id;
    if not v_exists then
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end if;
  end loop;

  -- QUO-01: the lines of those quotes (their entries carry quote_id, not the record's id); GAP-09: and their payment schedule
  for v_child in
    select distinct a.entity_type, a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type in ('quote_lines', 'quote_payment_steps') and a.entity_id is not null
       and coalesce(a.changes ->> 'quote_id', a.changes -> 'quote_id' ->> 'old') = any (
             select substr(c, length('quotes:') + 1) from unnest(v_children) c where c like 'quotes:%')
  loop
    execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)', v_child.entity_type)
      into v_exists using p_org, v_child.entity_id;
    if not v_exists then
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end if;
  end loop;

  -- QUO-07: a sent quote that was detached from the record keeps its number, date and amounts; its
  -- personal details are emptied, and its own entries are erased below with the rest. A draft that
  -- only named the record (a deal's quote naming a purged contact) is the deal's and is left alone.
  if p_type in ('contacts', 'deals') then
    for v_child in
      update public.quotes q
         set customer_name = null, customer_contact_name = null, notes = null, title = 'הצעת מחיר',
             -- QUO-11: the reason staff wrote when cancelling an accepted quote may name the customer
             cancel_reason = null
       where q.organization_id = p_org and q.status <> 'draft'
         and ((p_type = 'contacts' and q.former_contact_id = p_id) or (p_type = 'deals' and q.former_deal_id = p_id))
      returning 'quotes'::text as entity_type, q.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    -- owner, 18 October 2026 (QUO-07): the free text of those quotes' lines goes too: quantity, price and amounts stay;
    -- a free line and a group heading get a neutral name; every description is emptied. Owner, 19 October 2026: a
    -- product line's name that was edited by hand goes too. "Edited by hand" in the data = the stored name differs
    -- (trimmed) from the product's current catalog name; such a line takes the catalog name (not personal), and a
    -- product that is gone leaves the neutral name. A product line still named as in the catalog keeps it. Payment
    -- steps, milestones and terms stay (owner). These lines' entries (the old text included) are erased below.
    for v_child in
      update public.quote_lines l
         set description = null,
             name = case
                      when l.kind = 'group' then 'קבוצה'
                      when l.product_id is null then 'שורה'
                      else coalesce((select p.name from public.products p
                                      where p.organization_id = l.organization_id and p.id = l.product_id), 'שורה')
                    end
       where l.organization_id = p_org
         and l.quote_id = any (select substr(c, length('quotes:') + 1)::uuid from unnest(v_children) c where c like 'quotes:%')
         and exists (select 1 from public.quotes q where q.organization_id = p_org and q.id = l.quote_id and q.status <> 'draft')
      returning 'quote_lines'::text as entity_type, l.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    -- QUO-11: the cancel entry of those quotes on the timeline loses its " · סיבה: …" part (the rest is number and author);
    -- the entries' audit history (the old body included) is erased below with the rest
    for v_child in
      update public.activities ac
         set body = regexp_replace(ac.body, ' · סיבה: .*$', '')
       where ac.organization_id = p_org and ac.metadata ->> 'kind' = 'quote_cancelled'
         and ac.metadata ->> 'quote_id' = any (select substr(c, length('quotes:') + 1) from unnest(v_children) c where c like 'quotes:%')
         and ac.body like '% · סיבה: %'
      returning 'activities'::text as entity_type, ac.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    -- QUO-09 (owner, 18 October 2026): the customer's decision on those quotes keeps what, when and the fingerprint of the
    -- version; the signer's name, ID, signature, IP, browser and reason go (the table is not audited)
    update public.quote_decisions d
       set signer_name = null, signer_id_number = null, signature_image = null, ip = null, user_agent = null,
           decline_reason = null, erased_at = coalesce(d.erased_at, now())
     where d.organization_id = p_org
       and d.quote_id = any (select substr(c, length('quotes:') + 1)::uuid from unnest(v_children) c where c like 'quotes:%');
  end if;

  -- ORD-01: an order that was detached from the record keeps its number, date, lines' amounts and totals; the customer's
  -- name, the shipping address and the notes go, and its lines' free text goes as for quotes (a product line takes the
  -- catalog name, a free line and a heading a neutral one, every description is emptied). A draft only loses the
  -- shipping address and the name it may have copied from the record. Its entries are erased below with the rest.
  if p_type in ('contacts', 'companies', 'deals') then
    perform set_config('app.order_server', 'on', true);
    for v_child in
      update public.orders o
         set customer_name = case when o.status <> 'draft' then null else o.customer_name end,
             shipping_address = null,
             notes = case when o.status <> 'draft' then null else o.notes end
       where o.organization_id = p_org
         and ((p_type = 'contacts' and o.former_contact_id = p_id) or (p_type = 'deals' and o.former_deal_id = p_id)
              or (p_type = 'companies' and o.former_company_id = p_id))
      returning 'orders'::text as entity_type, o.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    -- ORD-05: the customer's answer on those orders keeps what, when and the fingerprint of what was shown; the signer's
    -- name, ID, signature, IP, browser and reason go (the table is not audited), as for quotes (QUO-09)
    update public.order_decisions d
       set signer_name = null, signer_id_number = null, signature_image = null, ip = null, user_agent = null,
           decline_reason = null, erased_at = coalesce(d.erased_at, now())
     where d.organization_id = p_org
       and d.order_id = any (select substr(c, length('orders:') + 1)::uuid from unnest(v_children) c where c like 'orders:%');
    for v_child in
      update public.order_lines l
         set description = null,
             name = case
                      when l.kind = 'group' then 'קבוצה'
                      when l.product_id is null then 'שורה'
                      else coalesce((select p.name from public.products p
                                      where p.organization_id = l.organization_id and p.id = l.product_id), 'שורה')
                    end
       where l.organization_id = p_org
         and l.order_id = any (select substr(c, length('orders:') + 1)::uuid from unnest(v_children) c where c like 'orders:%')
         and exists (select 1 from public.orders o where o.organization_id = p_org and o.id = l.order_id and o.status <> 'draft')
      returning 'order_lines'::text as entity_type, l.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    perform set_config('app.order_server', '', true);
  end if;
  -- the lines of those orders (kept or gone) that are gone themselves: their entries carry order_id; ORD-04: and their
  -- payment steps, as for quotes (the steps of a kept order stay, like a quote's)
  for v_child in
    select distinct a.entity_type, a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type in ('order_lines', 'order_payment_steps') and a.entity_id is not null
       and coalesce(a.changes ->> 'order_id', a.changes -> 'order_id' ->> 'old') = any (
             select substr(c, length('orders:') + 1) from unnest(v_children) c where c like 'orders:%')
  loop
    execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)', v_child.entity_type)
      into v_exists using p_org, v_child.entity_id;
    if not v_exists then
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end if;
  end loop;

  update public.audit_log a set changes = '{"erased": true}'::jsonb
   where a.organization_id = p_org
     and ((a.entity_type = p_type and a.entity_id = p_id) or (a.entity_type || ':' || a.entity_id) = any (v_children))
     and a.action <> 'erase'
     and a.changes is distinct from '{"erased": true}'::jsonb;
  get diagnostics v_count = row_count;

  -- the copy kept by a merge, on the record it was merged into
  update public.activities ac
     set metadata = ac.metadata - 'merged', body = 'מוזג עם רשומה כפולה (הפרטים נמחקו)'
   where ac.organization_id = p_org and ac.metadata ->> 'merged_id' = p_id::text and ac.metadata ? 'merged';
  get diagnostics v_more = row_count;
  v_count := v_count + v_more;

  v_count := v_count + app.erase_submissions(p_org, v_row);

  -- CNS-02: its consent history keeps only the hash, the state and the time
  if p_type in ('leads', 'contacts') then
    update public.consents c set method = null, wording = null, recorded_by = null, lift_note = null
     where c.organization_id = p_org
       and c.subject_type = case p_type when 'leads' then 'lead' else 'contact' end
       and c.subject_id = p_id
       and (c.method is not null or c.wording is not null or c.recorded_by is not null or c.lift_note is not null);
    get diagnostics v_more = row_count;
    v_count := v_count + v_more;
    -- an entry still waiting for its hash (written without the key): with the key there,
    -- it gets its hash first, so the opt-out keeps working; then the stored address is
    -- blanked. Without the key it stays unmatchable and keeps app.consent_suppressed() at
    -- "cannot check" for its channel (fail closed).
    if app.consent_key_present() then
      update public.consents c set address_hash = app.consent_pending_hash(c.id)
       where c.organization_id = p_org
         and c.subject_type = case p_type when 'leads' then 'lead' else 'contact' end
         and c.subject_id = p_id and c.address_hash is null and c.hash_version = 1
         and app.consent_pending_hash(c.id) is not null;
    end if;
    update app.consent_pending_address p set value = null
      from public.consents c
     where c.id = p.consent_id and c.organization_id = p_org
       and c.subject_type = case p_type when 'leads' then 'lead' else 'contact' end
       and c.subject_id = p_id and p.value is not null;
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, p_actor, 'erase', p_type, p_id, jsonb_build_object('entries', v_count));
  return v_count;
end;
$$;
revoke all on function app.audit_erase_core(uuid, text, uuid, uuid) from public, anon, authenticated;
