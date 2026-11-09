-- =============================================================================
-- CAP-11: the plan key meta_leads (owner, 8 November 2026, answer (143) ב)
-- =============================================================================
-- Facebook and Instagram Lead Ads open on the plans that hold lead_distribution: personal false, basic / pro / business
-- true. Only this key changes, no subscription or override is touched (the delta pattern of punch_cards_plan).
-- * app.plan_key_defaults() (body of punch_cards_plan) adds meta_leads: false, so a plan that does not hold the key has it
--   off; those plans then get it, set to false.
-- Mirrored by PLAN_VALUES / PLAN_KEY_FALLBACK in src/lib/plan-keys.ts (unit test).
-- Every statement is safe to run twice; a second run changes no row.

with delta as (
  select e.key, e.value as v
    from jsonb_each($delta$
{
  "personal": { "limits": {}, "features": { "meta_leads": false } },
  "basic": { "limits": {}, "features": { "meta_leads": true } },
  "pro": { "limits": {}, "features": { "meta_leads": true } },
  "business": { "limits": {}, "features": { "meta_leads": true } }
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
    "booking_team_pages": false,
    "lead_distribution": false,
    "campaign_costs": false,
    "punch_cards": false,
    "meta_leads": false
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
    "max_business_cards_per_user": 0,
    "max_booking_team_pages": 0,
    "ai_credits_per_month": 0,
    "ai_credits_per_user_per_month": 0
  }
}
$json$::jsonb
$$;
revoke all on function app.plan_key_defaults() from public, anon, authenticated;

-- Any other plan (the hidden free plan, a plan added in the admin panel) gets the key off; only this key is added, a
-- plan's own value is kept.
update public.plans p
   set features = jsonb_build_object('meta_leads', false) || coalesce(p.features, '{}'::jsonb)
 where not (coalesce(p.features, '{}'::jsonb) ? 'meta_leads');
