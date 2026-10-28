-- =============================================================================
-- 021092 QR codes: no new or changed external link while the platform has switched them off (BIZ-03)
-- =============================================================================
-- Owner's answer of 27 October 2026 (DECISIONS.md, "קוד QR לקישור חיצוני בזמן שהפלטפורמה כיבתה קישורים חיצוניים", (ג)):
-- while the platform has switched off a business's external links (app.qr_external_off, 021088), creating or editing a
-- code that leads to an external site is refused with a message that the platform switched external links off; the
-- existing link codes are shown as switched off in the list (app side).
--
-- * app.qr_codes_check (last defined in 021086; security definer, so it reads app.qr_external_off itself, which has no
--   grants): after the outsider guard (an outsider still gets RLS's plain 42501 and learns nothing), a write whose row is a
--   link (target_kind = 'url') is refused with P0001 hint 'qr_code:external_off' while the switch is on, when it is an
--   insert, or an update that turns the code into a link, changes the link, or switches the code on. Switching a link code
--   off, renaming it or deleting it stays allowed, so the business can clean up. Internal targets are untouched. The rule
--   holds for every writer (a person, a server path), like the other checks of this trigger: only the platform's own
--   switch turns it off.
-- No drop statement, no delete statement. Safe to run twice.

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
  -- BIZ-03 (owner, 27 October 2026, answer (ג)): no new, changed or re-activated link while the platform's switch is on
  if new.target_kind = 'url'
     and (tg_op = 'INSERT'
          or old.target_kind is distinct from 'url'
          or new.target_url is distinct from old.target_url
          or (new.is_active and not old.is_active))
     and app.qr_external_off(new.organization_id) then
    raise exception 'the platform has switched off this business''s external links'
      using errcode = 'P0001', hint = 'qr_code:external_off';
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
