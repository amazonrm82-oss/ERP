-- =============================================================================
-- 021086 QR codes: a business card or a link as the target (BIZ-03, the rest)
-- =============================================================================
-- Owner's answers of 18 October 2026 (DECISIONS.md, "קודי QR לפי מטרה"): (1) campaign tagging, one source "קוד QR";
-- (2) any https link may be a target, each code its own, only owners and admins set a target; (3) owners and admins manage
-- codes; (4) a rep's digital business card (BIZ-02) is a target, and its scans are counted on the code.
-- The approved pattern for public secret-link pages (CLAUDE.md hard rule 5) is unchanged: a scan is a counter only (no IP,
-- no device, no visitor id) and leads only to the code's stored target.
--
-- * public.qr_codes: target_kind also 'card' (business_card_id, composite FK set null like the form and the page) and
--   'url' (target_url). Exactly one target column per kind (qr_codes_target_shape); a 'url' code always holds its link.
-- * app.qr_target_url_ok(url): https only, at most 2,000 characters, printable ASCII without spaces or backslashes (the app
--   stores the browser's normalized form, so an Israeli domain arrives as punycode), no user name or password, a host name
--   of labels with a dot and a letter top-level label, an optional port 1..65535 without leading zeros. Mirrored by qrTargetUrlOk() in
--   src/features/qr-codes/target-url.ts; both read tests/unit/fixtures/qr-target-urls.json. Checked by the trigger (hint
--   qr_code:url) and by the constraint qr_codes_target_url_ok.
-- * app.qr_codes_check (last defined in 020295): a target is any of the four columns; a link is checked.
-- * public.qr_scan (last defined in 020295): a card answers {path: /f/card/<token>} while app.business_card_open holds (the
--   card page's own rule), else not found; a link answers {url}. The counter and its limits are unchanged.
-- No drop statement, no delete statement. Safe to run twice.

-- ----------------------------------------------------------------------------
-- The link rule
-- ----------------------------------------------------------------------------
create or replace function app.qr_target_url_ok(p_url text) returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(
    p_url is not null
    and char_length(p_url) <= 2000
    -- printable ASCII only: no spaces, no control or non-ASCII characters
    and p_url ~ '^[!-~]+$'
    and position(chr(92) in p_url) = 0
    -- https, then the authority up to the first / ? or #
    and p_url ~ '^https://[^/?#]+([/?#].*)?$'
    -- no user name or password
    and position('@' in substring(p_url from '^https://([^/?#]+)')) = 0
    -- the host: labels of letters, digits and inner hyphens, at least one dot, a letter (or punycode) top-level label;
    -- an optional port 1..65535, written without leading zeros
    and substring(p_url from '^https://([^/?#]+)')
        ~* '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})(:([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?$'
    and char_length(regexp_replace(substring(p_url from '^https://([^/?#]+)'), ':[0-9]+$', '')) <= 253,
    false)
$$;
revoke all on function app.qr_target_url_ok(text) from public, anon;
-- a check constraint runs with the writer's rights
grant execute on function app.qr_target_url_ok(text) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The new target columns
-- ----------------------------------------------------------------------------
alter table public.qr_codes add column if not exists business_card_id uuid;
alter table public.qr_codes add column if not exists target_url text;

alter table public.qr_codes drop constraint if exists qr_codes_target_kind_check;
alter table public.qr_codes add constraint qr_codes_target_kind_check
  check (target_kind in ('form', 'booking', 'card', 'url'));

alter table public.qr_codes drop constraint if exists qr_codes_business_card_fk;
alter table public.qr_codes add constraint qr_codes_business_card_fk foreign key (organization_id, business_card_id)
  references public.business_cards (organization_id, id) on delete set null (business_card_id);
create index if not exists qr_codes_business_card_idx on public.qr_codes (organization_id, business_card_id)
  where business_card_id is not null;

-- one target column per kind; an empty form, page or card means the target was deleted; a link is never empty
alter table public.qr_codes drop constraint if exists qr_codes_target_shape;
alter table public.qr_codes add constraint qr_codes_target_shape check (
  (target_kind = 'form' and booking_page_id is null and business_card_id is null and target_url is null)
  or (target_kind = 'booking' and form_id is null and business_card_id is null and target_url is null)
  or (target_kind = 'card' and form_id is null and booking_page_id is null and target_url is null)
  or (target_kind = 'url' and form_id is null and booking_page_id is null and business_card_id is null and target_url is not null));

alter table public.qr_codes drop constraint if exists qr_codes_target_url_ok;
alter table public.qr_codes add constraint qr_codes_target_url_ok
  check (target_url is null or app.qr_target_url_ok(target_url));

grant insert (organization_id, name, target_kind, form_id, booking_page_id, business_card_id, target_url, is_active)
  on public.qr_codes to authenticated;
grant update (name, target_kind, form_id, booking_page_id, business_card_id, target_url, is_active) on public.qr_codes to authenticated;

-- ----------------------------------------------------------------------------
-- The target and the plan (020295, plus the card and the link)
-- ----------------------------------------------------------------------------
create or replace function app.qr_codes_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_limit numeric;
begin
  if auth.uid() is not null and not (app.is_admin(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  if tg_op = 'INSERT' or new.target_kind is distinct from old.target_kind
     or new.form_id is distinct from old.form_id or new.booking_page_id is distinct from old.booking_page_id
     or new.business_card_id is distinct from old.business_card_id or new.target_url is distinct from old.target_url then
    -- a target is picked; an update may still clear a form, page or card (that only switches the code off in effect)
    if (tg_op = 'INSERT' or new.target_kind is distinct from old.target_kind)
       and coalesce(new.form_id, new.booking_page_id, new.business_card_id) is null and new.target_url is null then
      raise exception 'a QR code opens a form, a booking page, a business card or a link'
        using errcode = 'P0001', hint = 'qr_code:target';
    end if;
    if new.form_id is not null and not exists (select 1 from public.forms f
        where f.organization_id = new.organization_id and f.id = new.form_id and f.kind = 'form') then
      raise exception 'a QR code opens a web form' using errcode = 'P0001', hint = 'qr_code:target';
    end if;
    if new.target_url is not null and not app.qr_target_url_ok(new.target_url) then
      raise exception 'a QR code''s link must be a full https address' using errcode = 'P0001', hint = 'qr_code:url';
    end if;
  end if;
  if tg_op = 'INSERT' then
    if not app.org_has_feature(new.organization_id, 'qr_codes') then
      raise exception 'QR codes are not in the plan' using errcode = 'P0001', hint = 'feature:qr_codes';
    end if;
    v_limit := app.org_limit(new.organization_id, 'max_qr_codes');
    if v_limit is not null then
      perform pg_advisory_xact_lock(hashtextextended('qr_codes:' || new.organization_id::text, 0));
      if (select count(*) from public.qr_codes c where c.organization_id = new.organization_id) >= v_limit then
        raise exception 'QR code limit reached' using errcode = 'P0001', hint = 'limit:max_qr_codes';
      end if;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.qr_codes_check() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The scan (020295, plus the card and the link)
-- ----------------------------------------------------------------------------
-- Answers only the stored target and the code's name (the campaign tag); never an id, a count or anything else about the
-- business. An internal target answers {path, campaign}, a link {url, campaign}. Not found (P0002) unless the code is on,
-- the plan holds the flag, the business's public pages are open (app.org_public_pages_open) and the target is live: an
-- active web form, a booking page its own page would show (app.booking_page_state), a business card its own page would
-- show (app.business_card_open), or a stored link that still passes app.qr_target_url_ok. A scan is counted only while
-- the code's minute holds fewer than 60 counted scans.
create or replace function public.qr_scan(p_token text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_code public.qr_codes;
  v_path text;
  v_url text;
  v_page public.booking_pages;
  v_card public.business_cards;
  v_zone text;
  v_window integer;
begin
  select * into v_code from public.qr_codes c where c.token = coalesce(p_token, '');
  if v_code.id is null or not v_code.is_active
     or not app.org_public_pages_open(v_code.organization_id)
     or not app.org_has_feature(v_code.organization_id, 'qr_codes') then
    raise exception 'QR code not found' using errcode = 'P0002';
  end if;

  if v_code.target_kind = 'form' then
    select '/f/' || f.token into v_path
      from public.forms f
     where f.organization_id = v_code.organization_id and f.id = v_code.form_id and f.kind = 'form' and f.is_active;
  elsif v_code.target_kind = 'booking' then
    select * into v_page from public.booking_pages b
     where b.organization_id = v_code.organization_id and b.id = v_code.booking_page_id;
    if v_page.id is not null and app.booking_page_state(v_page) <> 'not_found' then
      v_path := '/f/book/' || v_page.token;
    end if;
  elsif v_code.target_kind = 'card' then
    select * into v_card from public.business_cards bc
     where bc.organization_id = v_code.organization_id and bc.id = v_code.business_card_id;
    if v_card.id is not null and app.business_card_open(v_card) then
      v_path := '/f/card/' || v_card.token;
    end if;
  elsif v_code.target_kind = 'url' and app.qr_target_url_ok(v_code.target_url) then
    v_url := v_code.target_url;
  end if;
  if v_path is null and v_url is null then
    raise exception 'QR code not found' using errcode = 'P0002';
  end if;

  -- the rate limit: counted first, so it is exact under parallel scans; only the code's own row is locked
  insert into app.qr_scan_windows as w (qr_code_id, window_start, scans)
  values (v_code.id, now(), 1)
  on conflict (qr_code_id) do update
    set window_start = case when w.window_start > now() - interval '1 minute' then w.window_start else now() end,
        scans = case when w.window_start > now() - interval '1 minute' then w.scans + 1 else 1 end
  returning w.scans into v_window;
  if v_window <= 60 then
    select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = v_code.organization_id;
    insert into app.qr_code_scan_days as d (qr_code_id, day, scans)
    values (v_code.id, (now() at time zone coalesce(v_zone, 'Asia/Jerusalem'))::date, 1)
    on conflict (qr_code_id, day) do update set scans = d.scans + 1;
  end if;

  if v_url is not null then
    return jsonb_build_object('url', v_url, 'campaign', v_code.name);
  end if;
  return jsonb_build_object('path', v_path, 'campaign', v_code.name);
end;
$$;
revoke all on function public.qr_scan(text) from public, anon, authenticated;
grant execute on function public.qr_scan(text) to service_role;
