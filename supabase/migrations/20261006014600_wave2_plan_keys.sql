-- =============================================================================
-- Wave 2 plan keys, and the "נבנה ב-Mexuz" line (owner, 13 October 2026)
-- =============================================================================
-- Every wave 2 module gets its own feature flag in plans.features, and every
-- count quota its own key in plans.limits, with the per-organization overrides
-- on subscriptions working as they do for the older keys. Until pricing is
-- decided every flag is on in every plan and every count quota has a high
-- temporary value (not "unlimited"). remove_built_with is off everywhere: the
-- public form shows the "נבנה ב-Mexuz" line unless an override turns it on.
-- Quotas of things that cost money per use (storage, SMS, email, WhatsApp
-- messages) are not added here without the owner's decision on each one. The
-- per-use quotas here (owner, 13 October 2026, temporary until pricing) are not
-- counted or enforced yet:
-- - max_pdf_per_month (1000): counted per new document version, resets monthly
--   in the organization's time zone, enforced by the PDF module (QUO-06).
-- - max_customer_emails_per_month (1000) and max_customer_emails_per_day (100):
--   count ONLY emails a business sends to its own customers (quotes, reminders,
--   booking confirmations). System emails to the business's users (verification,
--   password reset, invitations, staff notifications) are never counted and never
--   blocked. Bulk marketing gets its own quota later. Enforcement is in the
--   database behind the email provider layer (wave 3), so it works with the fake
--   provider too.
--
-- app.plan_key_defaults() is the one list. It is mirrored by
-- src/lib/plan-keys.ts (tests/unit/plan-keys.test.ts reads the JSON between the
-- $json$ quotes below and compares). Keep the two in step.
--
-- Missing keys: for the older keys nothing changes (a missing feature is off, a
-- missing limit is unlimited). A plan row without one of the keys below (a plan
-- added later by the platform staff) falls back to its default here, so a new
-- plan never switches a wave 2 module off or makes it unlimited by accident.
-- An explicit value on the plan or the override always wins, null included
-- (null limit = unlimited, as before).
--
-- Every statement is safe to run twice; existing keys on plans are never overwritten.

create or replace function app.plan_key_defaults() returns jsonb
language sql immutable
set search_path = ''
as $$
  select $json$
{
  "features": {
    "products": true,
    "price_lists": true,
    "discounts": true,
    "quotes": true,
    "orders": true,
    "documents": true,
    "payments": true,
    "balances": true,
    "collection": true,
    "money_waiting": true,
    "consents": true,
    "segments": true,
    "goals": true,
    "granular_permissions": true,
    "booking_page": true,
    "business_card": true,
    "qr_codes": true,
    "site_widget": true,
    "retention": true,
    "remove_built_with": false
  },
  "limits": {
    "max_products": 100000,
    "max_price_lists": 100000,
    "max_quote_templates": 100000,
    "max_booking_pages": 100000,
    "max_segments": 100000,
    "max_qr_codes": 100000,
    "max_pdf_per_month": 1000,
    "max_customer_emails_per_month": 1000,
    "max_customer_emails_per_day": 100
  }
}
$json$::jsonb
$$;
revoke all on function app.plan_key_defaults() from public, anon, authenticated;

-- Effective numeric limit for an organization; null = unlimited. A key the
-- plan does not hold falls back to app.plan_key_defaults() (null for older keys).
create or replace function app.org_limit(p_org uuid, p_key text) returns numeric
language sql stable security definer
set search_path = ''
as $$
  select case
    when s.limit_overrides ? p_key then (s.limit_overrides ->> p_key)::numeric
    when p.limits ? p_key then (p.limits ->> p_key)::numeric
    else (app.plan_key_defaults() -> 'limits' ->> p_key)::numeric
  end
  from public.subscriptions s
  join public.plans p on p.key = s.plan_key
  where s.organization_id = p_org
$$;

-- A missing or null value is off, as before; a key the plan does not hold
-- falls back to app.plan_key_defaults() (absent for older keys = off).
create or replace function app.org_has_feature(p_org uuid, p_key text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((
    select case
      when s.feature_overrides ? p_key then (s.feature_overrides ->> p_key)::boolean
      when p.features ? p_key then (p.features ->> p_key)::boolean
      else (app.plan_key_defaults() -> 'features' ->> p_key)::boolean
    end
    from public.subscriptions s
    join public.plans p on p.key = s.plan_key
    where s.organization_id = p_org
  ), false)
$$;

-- Seed every plan row: add only the keys it does not hold yet (the plan's own
-- value wins on the right side of ||).
update public.plans p
   set features = (app.plan_key_defaults() -> 'features') || coalesce(p.features, '{}'::jsonb),
       limits = (app.plan_key_defaults() -> 'limits') || coalesce(p.limits, '{}'::jsonb)
 where not (coalesce(p.features, '{}'::jsonb) ?& array(select jsonb_object_keys(app.plan_key_defaults() -> 'features')))
    or not (coalesce(p.limits, '{}'::jsonb) ?& array(select jsonb_object_keys(app.plan_key_defaults() -> 'limits')));

-- ----------------------------------------------------------------------------
-- "נבנה ב-Mexuz" on customer-facing pages (public form now, booking page later)
-- ----------------------------------------------------------------------------
-- Shown unless the organization's plan or override turns remove_built_with on.
-- A later public page (the booking page) calls this inside its own function.
create or replace function app.show_built_with(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select not app.org_has_feature(p_org, 'remove_built_with')
$$;
revoke all on function app.show_built_with(uuid) from public, anon, authenticated;

-- intake_form(): the body of 0127 (callback_slot_rules), plus 'built_with'
-- (true = the hosted form (/f/[token]) shows the line). Nothing else changes.
create or replace function public.intake_form(p_token text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_form public.forms%rowtype;
  v_fields jsonb;
  v_brand jsonb;
  v_whatsapp text;
  -- SPD-05
  v_callback jsonb;
  -- FLD-04: the "נבנה ב-Mexuz" line
  v_built_with boolean;
begin
  select * into v_form from public.forms f
   where f.token = coalesce(p_token, '') and f.kind = 'form';
  if not found or not v_form.is_active then
    return null;
  end if;

  select coalesce(jsonb_agg(x.field order by x.ord), '[]'::jsonb) into v_fields
    from (
      select a.ord,
             jsonb_build_object(
               'key', a.item ->> 'key',
               'required', coalesce(a.item -> 'required' = 'true'::jsonb, false),
               'help', coalesce(nullif(btrim(a.item ->> 'help'), ''), d.help_text),
               'show_if', case when jsonb_typeof(a.item -> 'show_if') = 'object' then a.item -> 'show_if' end,
               'label', d.label,
               'type', d.field_type,
               'options', d.options) as field
        from jsonb_array_elements(case when jsonb_typeof(v_form.fields) = 'array' then v_form.fields else '[]'::jsonb end)
               with ordinality as a(item, ord)
        left join public.field_definitions d
          on (a.item ->> 'key') like 'cf:%'
         and d.organization_id = v_form.organization_id
         and d.object_type = 'lead'
         and d.key = substr(a.item ->> 'key', 4)
         and d.is_active
         and d.field_type <> 'user'
       where (a.item ->> 'key') in ('full_name', 'phone', 'email', 'company_name', 'message')
          or d.id is not null
    ) x;

  -- FLD-04: only the logo's object name and the colour; nothing else of the organization
  select jsonb_build_object('logo', o.logo_path, 'color', o.brand_color) into v_brand
    from public.organizations o
   where o.id = v_form.organization_id;

  -- CAP-05: the WhatsApp number of the thank-you page, only when the form turns it on:
  -- the form's own number, else the business phone; only a valid E.164 number leaves
  if v_form.whatsapp_button then
    select app.normalize_phone(coalesce(nullif(btrim(v_form.whatsapp_phone), ''), o.phone)) into v_whatsapp
      from public.organizations o
     where o.id = v_form.organization_id;
    if v_whatsapp !~ '^\+[1-9][0-9]{7,14}$' then
      v_whatsapp := null;
    end if;
  end if;

  -- SPD-05: the call-back choice: the business's time zone, whether "now" is
  -- offered, and the slots still open today and on the next working day
  if v_form.callback_choice then
    select jsonb_build_object('time_zone', app.intake_zone(o.timezone))
           || app.intake_callback_offer(v_form.organization_id, v_form.callback_slots_off, now())
      into v_callback
      from public.organizations o
     where o.id = v_form.organization_id;
  end if;

  -- FLD-04: shown unless the plan or the override turns remove_built_with on; a bad
  -- plan value never fails the form (the line then shows)
  begin
    v_built_with := coalesce(app.show_built_with(v_form.organization_id), true);
  exception when others then
    v_built_with := true;
  end;

  return jsonb_build_object(
    'built_with', v_built_with,
    'callback', v_callback,
    'title', coalesce(nullif(btrim(v_form.title), ''), v_form.name),
    'intro', v_form.intro,
    'submit_label', v_form.submit_label,
    'fields', v_fields,
    'brand', coalesce(v_brand, jsonb_build_object('logo', null, 'color', null)),
    'thanks', jsonb_build_object(
      'whatsapp', v_whatsapp,
      'whatsapp_text', case when v_whatsapp is not null then nullif(btrim(v_form.whatsapp_text), '') end));
end;
$$;
revoke all on function public.intake_form(text) from public, anon, authenticated;
grant execute on function public.intake_form(text) to service_role;
