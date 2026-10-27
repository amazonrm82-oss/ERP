-- =============================================================================
-- 021088 QR codes: a page before an external link, and the platform's emergency switch (BIZ-03)
-- =============================================================================
-- Owner's answer of 27 October 2026 (DECISIONS.md, "קוד QR לקישור חיצוני: שימוש לרעה", (ד) + (ה)):
-- (ד) every external target (a code of kind 'url') shows a page "אתם עוברים לאתר [דומיין]. [שם העסק] אחראי לתוכן שלו" before
--     the visitor goes on; an internal target (form, booking page, business card) redirects as before.
-- (ה) a platform emergency switch turns off one business's external links, logged in the platform log.
--
-- * app.qr_external_blocks: one row per business that was ever switched; `blocked` is the state, `reason`, `changed_by` and
--   `changed_at` the latest change (every change is also in app.platform_log). Schema app: RLS on, no policies, no grants
--   (RVW-15). A row is never removed: switching back sets blocked = false.
-- * public.platform_set_qr_external_block(org, blocked, reason): platform owner or support, with aal2
--   (app.require_platform), reason 1..500; idempotent: the same state again changes nothing and logs nothing; a change is
--   logged as qr_external.block | qr_external.unblock with the reason. Answers {blocked, changed}.
-- * public.platform_qr_external_block(org): every platform role reads the state for the business's admin card.
-- * public.qr_external_blocked(org): a member of the business reads one boolean (null for anyone else), for the QR settings
--   screen. Creating or editing a link code stays allowed while blocked: the scan is where the switch is enforced.
-- * public.qr_scan (last defined in 021086): a link answers {url, campaign, business} (the display name,
--   organizations.name, for the page before the link) and is not found while the business's external links are switched
--   off (nothing counted). Internal targets: unchanged.
-- No drop statement, no delete statement. Safe to run twice.

-- ----------------------------------------------------------------------------
-- The switch
-- ----------------------------------------------------------------------------
create table if not exists app.qr_external_blocks (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  blocked         boolean not null,
  reason          text not null check (char_length(reason) between 1 and 500),
  changed_by      uuid,
  changed_at      timestamptz not null default now()
);
alter table app.qr_external_blocks enable row level security;
revoke all on app.qr_external_blocks from public, anon, authenticated, service_role;

-- true while the platform has switched off the business's external QR links (internal helper, no grants)
create or replace function app.qr_external_off(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((select b.blocked from app.qr_external_blocks b where b.organization_id = p_org), false)
$$;
revoke all on function app.qr_external_off(uuid) from public, anon, authenticated, service_role;

create or replace function public.platform_set_qr_external_block(p_org uuid, p_blocked boolean, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  v_current boolean;
begin
  perform app.require_platform(array['support']);
  if p_blocked is null or char_length(v_reason) not between 1 and 500 then
    raise exception 'a state and a reason (1..500) are required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'organization not found' using errcode = 'P0002';
  end if;
  -- one change at a time per business: the row is taken first; a business never switched has no row (= links on)
  select b.blocked into v_current from app.qr_external_blocks b where b.organization_id = p_org for update;
  if v_current is null and p_blocked then
    insert into app.qr_external_blocks (organization_id, blocked, reason, changed_by)
    values (p_org, true, v_reason, auth.uid())
    on conflict (organization_id) do nothing;
    if found then
      perform app.log_platform('qr_external.block', p_org, jsonb_build_object('reason', v_reason));
      return jsonb_build_object('blocked', true, 'changed', true);
    end if;
    -- a parallel first switch won the insert: judge against its row
    select b.blocked into v_current from app.qr_external_blocks b where b.organization_id = p_org for update;
  end if;
  if coalesce(v_current, false) = p_blocked then
    return jsonb_build_object('blocked', p_blocked, 'changed', false);
  end if;
  update app.qr_external_blocks
     set blocked = p_blocked, reason = v_reason, changed_by = auth.uid(), changed_at = now()
   where organization_id = p_org;
  perform app.log_platform(case when p_blocked then 'qr_external.block' else 'qr_external.unblock' end, p_org,
    jsonb_build_object('reason', v_reason));
  return jsonb_build_object('blocked', p_blocked, 'changed', true);
end;
$$;
revoke all on function public.platform_set_qr_external_block(uuid, boolean, text) from public, anon;
grant execute on function public.platform_set_qr_external_block(uuid, boolean, text) to authenticated;

create or replace function public.platform_qr_external_block(p_org uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_row app.qr_external_blocks;
begin
  perform app.require_platform(array['support', 'finance', 'readonly']);
  select * into v_row from app.qr_external_blocks b where b.organization_id = p_org;
  if v_row.organization_id is null then
    return jsonb_build_object('blocked', false);
  end if;
  return jsonb_build_object('blocked', v_row.blocked, 'reason', v_row.reason, 'changed_at', v_row.changed_at);
end;
$$;
revoke all on function public.platform_qr_external_block(uuid) from public, anon;
grant execute on function public.platform_qr_external_block(uuid) to authenticated;

-- a member of the business learns one boolean; anyone else gets null
create or replace function public.qr_external_blocked(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select case when app.is_member(p_org) then app.qr_external_off(p_org) end
$$;
revoke all on function public.qr_external_blocked(uuid) from public, anon;
grant execute on function public.qr_external_blocked(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The scan (021086, plus the business's name for a link and the switch)
-- ----------------------------------------------------------------------------
-- Answers only the stored target and the code's name (the campaign tag); a link also the business's display name for the
-- page shown before it; never an id, a count or anything else about the business. An internal target answers
-- {path, campaign}, a link {url, campaign, business}. Not found (P0002) unless the code is on, the plan holds the flag, the
-- business's public pages are open (app.org_public_pages_open) and the target is live: an active web form, a booking page
-- its own page would show (app.booking_page_state), a business card its own page would show (app.business_card_open), or a
-- stored link that still passes app.qr_target_url_ok while the platform has not switched off the business's external links
-- (app.qr_external_off). A scan is counted only while the code's minute holds fewer than 60 counted scans.
create or replace function public.qr_scan(p_token text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_code public.qr_codes;
  v_path text;
  v_url text;
  v_business text;
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
  elsif v_code.target_kind = 'url' and app.qr_target_url_ok(v_code.target_url)
        and not app.qr_external_off(v_code.organization_id) then
    select o.name into v_business from public.organizations o where o.id = v_code.organization_id;
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
    return jsonb_build_object('url', v_url, 'campaign', v_code.name, 'business', coalesce(v_business, ''));
  end if;
  return jsonb_build_object('path', v_path, 'campaign', v_code.name);
end;
$$;
revoke all on function public.qr_scan(text) from public, anon, authenticated;
grant execute on function public.qr_scan(text) to service_role;
