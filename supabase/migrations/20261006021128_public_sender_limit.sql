-- =============================================================================
-- OPS-02 (owner's answers of 2 November 2026): one limit per sender against guessed secret links, and the quote page's
-- per-sender view limit
-- =============================================================================
-- (40) ב and (42) ד: the secret-link pages (the customer's quote, order and statement pages, all their decide/question/pdf routes,
-- and the personal booking-manage link with its route) share ONE limit per sender against guessing links: 120 "not found"
-- answers in 10 minutes across all of them, then "too many requests" BEFORE the token is looked up. Owner (42) ד: the lead form,
-- the widget, the booking page and (lead's call) the business card are published to everyone and keep only their own limits;
-- (43) א: the calendar feed, the intake webhook and the QR scan stay out. Only "not found" answers count, so a customer who opens
-- a real link many times is never refused here (their page keeps its own per-link and per-sender limits). Not the Vercel firewall.
--
-- * public.public_sender_check(p_sender text) returns boolean: reads the sender's bucket only; false while the bucket's window
--   is current and its count has reached app.public_sender_limit(). public.public_sender_miss(p_sender text) returns integer: one
--   atomic upsert (+1, or 1 when the window passed), the new count. Both security definer, service_role only (the approved
--   pattern of CLAUDE.md hard rule 5, used by the existing secret-link paths, owner's answers (40) and (42)). p_sender is the
--   server's keyed IP hash (src/lib/keyed-ip-hash.ts, FXS-11 scope 'public': one value per visitor across the pages); a value
--   that is not 64 lower-case hex characters (null: no secret set, no address) is neither checked (true) nor counted (null):
--   fail open, as every other public limit (no secret = no hash).
-- * app.public_sender_counts: 65,536 reused buckets keyed by the hash alone (window start + misses). Only the bucket number is
--   kept, never the hash, so there is nothing to clear (as app.link_preview_ip_counts); two senders that share a bucket share
--   its count (accepted, as WAB-05; 65,536 buckets keep that rare).
-- * The app (src/lib/public-sender-server.ts): a page checks inside its cache()d loader, runs its own function, records a miss
--   when that answered not found; a route checks, runs its handler, records a miss when the handler marked its 404 as "not
--   found" (src/lib/public-not-found.ts; a real link's "file unavailable" 404 is not a miss). Preview bots never reach it
--   (WAB-05 counts them first with its own limits).
-- * The cap is soft: the check runs before the lookup and the miss is written after it, so a burst already in flight can pass
--   120 by a few. A shared address (an office, a mobile carrier's CGNAT) is one sender: someone else's misses can refuse a real
--   customer behind it for the rest of the window (accepted by the lead under answers (40) and (42)). An IPv6 visitor is
--   counted by its /64 (src/lib/ip-prefix.ts, this scope only), so rotating inside it does not reset the count.
--
-- (41) ב: the customer's quote page also limits each sender to 60 views in 10 minutes, as order_public and statement_public:
-- counted after the token lookup and the link's 120 window, the sender scoped to the link's quote by app.quote_link_sender,
-- 1,024 reused buckets per quote in app.quote_link_view_counts (no hash kept; cascades with the quote).
-- * public.quote_public keeps its one signature (quote_signed_pdf_public and the 021126 render call it with the token alone):
--   the sender arrives in the request header x-crm-sender, read by app.public_sender_header() (021127, as intake_form). No
--   header = not counted: the signed PDF's own read and a live page older than this file. The rest of the body is 021087's,
--   unchanged; every not-found answer is unchanged (test 253).
--
-- Safe to run twice; nothing is removed; backward compatible (the live code sends no sender: nothing is counted).

-- ----------------------------------------------------------------------------
-- (40) The counters: one row per bucket, reused by the next window (an update, never a row removal)
-- ----------------------------------------------------------------------------
create table if not exists app.public_sender_counts (
  bucket       integer primary key check (bucket between 0 and 65535),
  window_start timestamptz not null,
  misses       integer not null
);
alter table app.public_sender_counts enable row level security;
revoke all on app.public_sender_counts from public, anon, authenticated, service_role;

-- "not found" answers per sender in 10 minutes across the secret-link pages (owner, 2 November 2026, answers (40) ב, (42) ד)
create or replace function app.public_sender_limit() returns integer
language sql immutable
set search_path = ''
as $$ select 120 $$;
revoke all on function app.public_sender_limit() from public, anon, authenticated, service_role;

-- The bucket of a keyed hash, or null for anything that is not one
create or replace function app.public_sender_bucket(p_sender text) returns integer
language sql immutable
set search_path = ''
as $$
  select case when p_sender ~ '^[0-9a-f]{64}$' then ((hashtextextended(p_sender, 0) % 65536) + 65536) % 65536 end
$$;
revoke all on function app.public_sender_bucket(text) from public, anon, authenticated, service_role;

-- Before the lookup: may this sender go on? A read only
create or replace function public.public_sender_check(p_sender text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select not exists (
    select 1 from app.public_sender_counts sc
     where sc.bucket = app.public_sender_bucket(p_sender)
       and sc.window_start > now() - interval '10 minutes'
       and sc.misses >= app.public_sender_limit())
$$;
revoke all on function public.public_sender_check(text) from public, anon, authenticated;
grant execute on function public.public_sender_check(text) to service_role;

-- After a "not found": one miss, one atomic upsert; answers the new count (null = not a keyed hash, not counted)
create or replace function public.public_sender_miss(p_sender text) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_bucket integer := app.public_sender_bucket(p_sender);
  v_misses integer;
begin
  if v_bucket is null then
    return null;
  end if;
  insert into app.public_sender_counts as sc (bucket, window_start, misses)
  values (v_bucket, now(), 1)
  on conflict (bucket) do update
    set window_start = case when sc.window_start > now() - interval '10 minutes' then sc.window_start else now() end,
        misses = case when sc.window_start > now() - interval '10 minutes' then sc.misses + 1 else 1 end
  returning sc.misses into v_misses;
  return v_misses;
end;
$$;
revoke all on function public.public_sender_miss(text) from public, anon, authenticated;
grant execute on function public.public_sender_miss(text) to service_role;

-- ----------------------------------------------------------------------------
-- (41) The quote page's per-sender view counters (as app.order_link_view_counts, with the quote's tenant key)
-- ----------------------------------------------------------------------------
create table if not exists app.quote_link_view_counts (
  organization_id uuid not null,
  quote_id        uuid not null,
  bucket          integer not null check (bucket between 0 and 1023),
  window_start    timestamptz not null,
  views           integer not null,
  primary key (quote_id, bucket),
  constraint quote_link_view_counts_quote_fk foreign key (organization_id, quote_id)
    references public.quotes (organization_id, id) on delete cascade
);
create index if not exists quote_link_view_counts_quote_idx on app.quote_link_view_counts (organization_id, quote_id);
alter table app.quote_link_view_counts enable row level security;
revoke all on app.quote_link_view_counts from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- public.quote_public: 021087's body, plus the per-sender view limit after the link's window
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
  -- OPS-02 (owner (41) ב): the per-sender view limit
  v_sender text;
  v_bucket integer;
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
  -- OPS-02 (owner, 2 November 2026, answer (41) ב): 60 views per sender in 10 minutes, as order_public and statement_public,
  -- counted after the token lookup and the link's window. The sender is the server's keyed IP hash (FXS-11 scope 'quote'),
  -- handed over in the request header x-crm-sender (app.public_sender_header, 021127) and scoped to the link's quote by
  -- app.quote_link_sender; no header = not counted (the signed PDF's own read, quote_public_answer, a page older than this file).
  -- Only a bucket number is kept, never the hash.
  v_sender := app.quote_link_sender(v_link.quote_id, app.public_sender_header());
  if v_sender is not null then
    v_bucket := ((hashtextextended(v_sender, 0) % 1024) + 1024) % 1024;
    insert into app.quote_link_view_counts as vc (organization_id, quote_id, bucket, window_start, views)
    values (v_link.organization_id, v_link.quote_id, v_bucket, now(), 1)
    on conflict (quote_id, bucket) do update
      set window_start = case when vc.window_start > now() - interval '10 minutes' then vc.window_start else now() end,
          views = case when vc.window_start > now() - interval '10 minutes' then vc.views + 1 else 1 end
    returning vc.views into v_count;
    if v_count > 60 then
      return jsonb_build_object('rate_limited', true);
    end if;
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
