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

-- The hosted form (/f/[token]) asks whether to show the line. Same rules as
-- intake_form(): only an active form answers; null otherwise. It tells nothing
-- else about the organization.
create or replace function public.intake_form_built_with(p_token text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app.show_built_with(f.organization_id)
    from public.forms f
   where f.token = coalesce(p_token, '') and f.kind = 'form' and f.is_active
$$;
revoke all on function public.intake_form_built_with(text) from public, anon, authenticated;
grant execute on function public.intake_form_built_with(text) to service_role;
