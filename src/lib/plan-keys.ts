// Wave 2 plan keys (owner, 13 October 2026). Mirrors app.plan_key_defaults() in
// supabase/migrations/20261006013500_wave2_plan_keys.sql; tests/unit/plan-keys.test.ts
// keeps the two equal. Until pricing is decided every flag is on in every plan
// (remove_built_with off) and every count quota has a high temporary value.
// A module checks its own key in the database (app.org_has_feature / app.org_limit,
// hints 'feature:<key>' / 'limit:<key>'); no screen is gated by this file.

/** Feature flags in plans.features, with their temporary value in every plan. */
export const WAVE2_FEATURES = {
  products: true, // PRD-01..08
  price_lists: true, // PL-01..03
  discounts: true, // DSC-01
  quotes: true, // QUO-01..17 (with the signature)
  orders: true, // ORD-01..06 (optional module, off per organization until turned on)
  documents: true, // DOC-01..04 (manual documents)
  payments: true, // PAY-01..07
  balances: true, // BAL-01..04
  collection: true, // COL-01..06
  money_waiting: true, // MNY-01, MNY-02, MNY-05
  consents: true, // CNS-01..06
  segments: true, // SEG-01, SEG-02
  goals: true, // GOL-01..04 (goals and forecast)
  granular_permissions: true, // PRM-01
  booking_page: true, // CAL-08, CAL-10, CAL-11
  business_card: true, // BIZ-02
  qr_codes: true, // BIZ-03
  site_widget: true, // SPD-07
  retention: true, // PRV-01..03
  remove_built_with: false, // FLD-04: on = the "נבנה ב-Mexuz" line is hidden
} as const;

/** Count quotas in plans.limits (not per-use), with their temporary value in every plan. */
export const WAVE2_LIMITS = {
  max_products: 100000, // PRD-08
  max_price_lists: 100000, // PL-01
  max_quote_templates: 100000, // QUO-04
  max_booking_pages: 100000, // CAL-10
  max_segments: 100000, // SEG-01
  max_qr_codes: 100000, // BIZ-03
} as const;

export type Wave2FeatureKey = keyof typeof WAVE2_FEATURES;
export type Wave2LimitKey = keyof typeof WAVE2_LIMITS;

export const WAVE2_FEATURE_KEYS = Object.keys(WAVE2_FEATURES) as Wave2FeatureKey[];
export const WAVE2_LIMIT_KEYS = Object.keys(WAVE2_LIMITS) as Wave2LimitKey[];

/** The flag that hides the "נבנה ב-Mexuz" line on customer-facing pages. */
export const REMOVE_BUILT_WITH: Wave2FeatureKey = "remove_built_with";
