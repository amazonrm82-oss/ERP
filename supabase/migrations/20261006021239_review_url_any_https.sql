-- =============================================================================
-- RET-02 (owner 12 November 2026, answer (307) ב): the review link may be any https link the QR link rule accepts
-- =============================================================================
-- The business's review page may be on Google, Facebook, easy, Zap or any other site. So app.review_url_ok is now exactly
-- BIZ-03's link rule app.qr_target_url_ok (https, printable ASCII, no user name or password, a DNS host, at most 2,000
-- characters), reused, not copied. Mirrored by reviewUrlOk() = qrTargetUrlOk() in src/features/review-requests/review-url.ts;
-- both read tests/unit/fixtures/review-urls.json (and the QR rule its own fixture).
--
-- Every stored link stays valid: the old rule (021235) accepted a subset of this one (it began with app.qr_target_url_ok).
-- app.review_url_query_ok (021235) has no caller now; it stays defined (no drop statement).
--
-- THE FUTURE SENDER (unchanged from 021235): it fills {קישור לביקורת} only with the link stored in
-- review_request_settings.review_url, and sends nothing unless that stored link still passes app.review_url_ok.
--
-- Independent review of the branch:
-- * (1) The platform's outside-link switch (app.qr_external_blocks, BIZ-03 021088): while it holds a business, switching
--   review requests on, or a new or changed link, is refused (hint review_request:external_off); switching off and the other
--   settings stay allowed. The job skips such a business (021240), and the settings screen says so (public.qr_external_blocked).
-- * (5) A new or changed link is at most 300 characters (hint review_request:url_long; = REVIEW_URL_MAX). A stored longer
--   link stays valid until it is changed (the column's own limit stays 2,000).
-- app.review_request_settings_check: 021235's body plus those two blocks; the link rule is still judged on every write.
--
-- Safe to run twice. No drop statement, no delete.

create or replace function app.review_url_ok(p_url text) returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(app.qr_target_url_ok(p_url), false)
$$;
revoke all on function app.review_url_ok(text) from public, anon, authenticated;

create or replace function app.review_request_url_max() returns integer
language sql immutable
set search_path = ''
as $$ select 300 $$;
revoke all on function app.review_request_url_max() from public, anon, authenticated, service_role;

-- 021235's rules of a row (every writer; an outsider is left to RLS), plus the outside-link switch and the length
create or replace function app.review_request_settings_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_turning_on boolean;
  v_link_changed boolean;
begin
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  -- enabled_at is the server's: kept on an update, set only when the requests are switched on
  if tg_op = 'UPDATE' then
    new.enabled_at := old.enabled_at;
    v_turning_on := new.enabled and not old.enabled;
  else
    new.enabled_at := null;
    v_turning_on := new.enabled;
  end if;
  new.review_url := nullif(btrim(new.review_url), '');
  v_link_changed := new.review_url is not null
                    and (tg_op = 'INSERT' or new.review_url is distinct from old.review_url);
  if new.review_url is not null and not app.review_url_ok(new.review_url) then
    raise exception 'the review link is not a valid https link'
      using errcode = 'P0001', hint = 'review_request:url';
  end if;
  -- review (5): a new or changed link is at most 300 characters
  if v_link_changed and char_length(new.review_url) > app.review_request_url_max() then
    raise exception 'the review link is too long'
      using errcode = 'P0001', hint = 'review_request:url_long';
  end if;
  if new.enabled and (new.review_url is null or not (new.on_deal_won or new.on_meeting_held)) then
    raise exception 'review requests need a link and at least one trigger'
      using errcode = 'P0001', hint = 'review_request:incomplete';
  end if;
  -- review (1): while the platform has switched off the business's outside links, no switching on and no new link
  if (v_turning_on or v_link_changed) and app.qr_external_off(new.organization_id) then
    raise exception 'outside links are switched off for this business'
      using errcode = 'P0001', hint = 'review_request:external_off';
  end if;
  if v_turning_on then
    if not coalesce(app.org_has_feature(new.organization_id, 'review_requests'), false) then
      raise exception 'review requests are not in the plan'
        using errcode = 'P0001', hint = 'feature:review_requests';
    end if;
    new.enabled_at := now();
  end if;
  return new;
end;
$$;
revoke all on function app.review_request_settings_check() from public, anon, authenticated, service_role;
