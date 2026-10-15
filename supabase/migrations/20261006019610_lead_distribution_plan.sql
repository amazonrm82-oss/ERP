-- =============================================================================
-- CAP-08: the plan key lead_distribution (owner, 14 October 2026)
-- =============================================================================
-- Distribution by weight, by open load and by rules opens from "בסיס" up, the same
-- plans as auto_reassign (DECISIONS.md, "חלוקת לידים: באילו חבילות").
-- * The four sold plans get the flag (personal false, basic / pro / business true);
--   only this key changes, no subscription or override is touched (the delta pattern
--   of plan_trial_built_with).
-- * app.plan_key_defaults() (body of plan_review_fixes) adds lead_distribution: false,
--   so a plan that does not hold the key (the hidden free plan, a plan added later in the
--   admin panel) has it off; the plans without the key then get it, set to false (only
--   this key is added).
-- Mirrored by PLAN_VALUES / PLAN_KEY_FALLBACK in src/lib/plan-keys.ts (unit test).
-- Every statement is safe to run twice; a second run changes no row.

with delta as (
  select e.key, e.value as v
    from jsonb_each($delta$
{
  "personal": { "limits": {}, "features": { "lead_distribution": false } },
  "basic": { "limits": {}, "features": { "lead_distribution": true } },
  "pro": { "limits": {}, "features": { "lead_distribution": true } },
  "business": { "limits": {}, "features": { "lead_distribution": true } }
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
    "lead_distribution": false
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

-- Any other plan (the hidden free plan, a plan added in the admin panel) gets the key
-- off; only this key is added, a plan's own value is kept.
update public.plans p
   set features = jsonb_build_object('lead_distribution', false) || coalesce(p.features, '{}'::jsonb)
 where not (coalesce(p.features, '{}'::jsonb) ? 'lead_distribution');
