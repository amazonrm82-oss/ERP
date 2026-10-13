-- =============================================================================
-- Trial businesses keep "נבנה ב-Mexuz"; wave 2 capabilities outside the pricing
-- table (owner's decisions, 13 October 2026)
-- =============================================================================
-- 1. A business in its trial runs at the pro level but keeps the line. It goes
--    only for a subscription that is not trialing (active, past_due, cancelled)
--    whose plan (or override) has remove_built_with. An override of
--    remove_built_with on the subscription decides alone (support cases).
-- 2. The wave 2 capabilities that the pricing table left out: open in every plan,
--    granular_permissions from pro up; their quotas replace the 100000
--    placeholders, plus max_site_widgets and max_business_cards_per_user (one
--    card per paid user; the "_per_user" rule of src/lib/plan-keys.ts).
--    Only these keys change, only on the four sold plans; no subscription or
--    override is touched. The changes are mirrored by PLAN_VALUES and the defaults
--    by PLAN_KEY_FALLBACK in src/lib/plan-keys.ts (unit test).
-- Every statement is safe to run twice; a second run changes no row.

create or replace function app.show_built_with(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select case
    when s.feature_overrides ? 'remove_built_with'
      then not coalesce((s.feature_overrides ->> 'remove_built_with')::boolean, false)
    else not (s.status <> 'trialing' and app.org_has_feature(p_org, 'remove_built_with'))
  end
    from public.subscriptions s
   where s.organization_id = p_org
$$;
revoke all on function app.show_built_with(uuid) from public, anon, authenticated;

with delta as (
  select e.key, e.value as v
    from jsonb_each($delta$
{
  "personal": {
    "limits": {
      "max_price_lists": 1,
      "max_quote_templates": 3,
      "max_segments": 3,
      "max_qr_codes": 5,
      "max_site_widgets": 1,
      "max_business_cards_per_user": 1
    },
    "features": {
      "products": true,
      "price_lists": true,
      "discounts": true,
      "documents": true,
      "payments": true,
      "collection": true,
      "consents": true,
      "segments": true,
      "business_card": true,
      "qr_codes": true,
      "site_widget": true,
      "retention": true,
      "granular_permissions": false
    }
  },
  "basic": {
    "limits": {
      "max_price_lists": 3,
      "max_quote_templates": 10,
      "max_segments": 10,
      "max_qr_codes": 20,
      "max_site_widgets": 3,
      "max_business_cards_per_user": 1
    },
    "features": {
      "products": true,
      "price_lists": true,
      "discounts": true,
      "documents": true,
      "payments": true,
      "collection": true,
      "consents": true,
      "segments": true,
      "business_card": true,
      "qr_codes": true,
      "site_widget": true,
      "retention": true,
      "granular_permissions": false
    }
  },
  "pro": {
    "limits": {
      "max_price_lists": 20,
      "max_quote_templates": 50,
      "max_segments": 50,
      "max_qr_codes": 100,
      "max_site_widgets": 10,
      "max_business_cards_per_user": 1
    },
    "features": {
      "products": true,
      "price_lists": true,
      "discounts": true,
      "documents": true,
      "payments": true,
      "collection": true,
      "consents": true,
      "segments": true,
      "business_card": true,
      "qr_codes": true,
      "site_widget": true,
      "retention": true,
      "granular_permissions": true
    }
  },
  "business": {
    "limits": {
      "max_price_lists": 100,
      "max_quote_templates": 200,
      "max_segments": 200,
      "max_qr_codes": 500,
      "max_site_widgets": 50,
      "max_business_cards_per_user": 1
    },
    "features": {
      "products": true,
      "price_lists": true,
      "discounts": true,
      "documents": true,
      "payments": true,
      "collection": true,
      "consents": true,
      "segments": true,
      "business_card": true,
      "qr_codes": true,
      "site_widget": true,
      "retention": true,
      "granular_permissions": true
    }
  }
}
$delta$::jsonb) e
)
update public.plans p
   set limits = p.limits || (d.v -> 'limits'),
       features = p.features || (d.v -> 'features')
  from delta d
 where p.key = d.key
   and (p.limits, p.features) is distinct from (p.limits || (d.v -> 'limits'), p.features || (d.v -> 'features'));

-- the value of a wave 2 key that a plan does not hold: the most restrictive
create or replace function app.plan_key_defaults() returns jsonb
language sql immutable
set search_path = ''
as $$
  select $json$
{
  "features": {
    "products": false,
    "price_lists": false,
    "discounts": false,
    "quotes": false,
    "orders": false,
    "documents": false,
    "payments": false,
    "balances": false,
    "collection": false,
    "money_waiting": false,
    "consents": false,
    "segments": false,
    "goals": false,
    "granular_permissions": false,
    "booking_page": false,
    "business_card": false,
    "qr_codes": false,
    "site_widget": false,
    "retention": false,
    "remove_built_with": false,
    "payment_links": false,
    "instant_reply": false,
    "auto_reassign": false,
    "dashboards": false,
    "goals_per_rep": false,
    "booking_team_pages": false
  },
  "limits": {
    "max_products": 0,
    "max_price_lists": 0,
    "max_quote_templates": 0,
    "max_booking_pages": 0,
    "max_booking_pages_per_user": 0,
    "max_segments": 0,
    "max_qr_codes": 0,
    "max_pdf_per_month": 0,
    "max_customer_emails_per_month": 0,
    "max_customer_emails_per_day": 0,
    "max_custom_reports": 0,
    "max_custom_objects": 0,
    "max_teams": 0,
    "max_whatsapp_numbers": 0,
    "view_seats_per_paid_seat": 0,
    "max_site_widgets": 0,
    "max_business_cards_per_user": 0
  }
}
$json$::jsonb
$$;
revoke all on function app.plan_key_defaults() from public, anon, authenticated;
