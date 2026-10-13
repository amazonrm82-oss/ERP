// Plan keys, prices and states (owner's pricing of 13 October 2026; it replaces the
// temporary "everything open, high values" defaults). Mirrors migrations plan_pricing
// (the seed) and plan_trial_built_with (the changes of the owner's second decision,
// and app.plan_key_defaults()): PLAN_VALUES = the seed with those changes,
// PLAN_KEY_FALLBACK = the latest app.plan_key_defaults(). tests/unit/plan-keys.test.ts
// reads both migrations and compares; keep them in step.
//
// Every limit and flag is its own key in plans.limits / plans.features, editable in
// the admin panel without code, with per-organization overrides on subscriptions.
// A limit of null means no cap. A module checks its own key in the database
// (app.org_has_feature / app.org_limit, hints 'feature:<key>' / 'limit:<key>').
//
// Per-user quotas: a limit key that contains "_per_user" is per paid (full) seat; the
// quota code multiplies it by the paid seats and adds the business-wide key of the
// same quota when there is one (orgAllowance below). Every other key is per business.
// Example: AI credits = ai_credits_per_month + ai_credits_per_user_per_month x seats.

export const PRICE_UNITS = ["org", "seat"] as const;
export type PriceUnit = (typeof PRICE_UNITS)[number];

export const PLAN_AVAILABILITIES = ["hidden", "coming_soon", "available"] as const;
export type PlanAvailability = (typeof PLAN_AVAILABILITIES)[number];

/** The plans that are sold (the free plan is hidden and keeps its own values). */
export const SOLD_PLANS = ["personal", "basic", "pro", "business"] as const;
export type SoldPlan = (typeof SOLD_PLANS)[number];

type PlanValues = {
  price_monthly_agorot: number;
  price_annual_agorot: number;
  price_unit: PriceUnit;
  availability: PlanAvailability;
  position: number;
  limits: Record<string, number | null>;
  features: Record<string, boolean>;
};

const byPlan = <T>(personal: T, basic: T, pro: T, business: T): Record<SoldPlan, T> => ({ personal, basic, pro, business });

// value per plan: personal / basic / pro / business
const LIMITS: Record<string, Record<SoldPlan, number | null>> = {
  max_users: byPlan(2, null, null, null),
  max_records: byPlan(10000, 25000, 250000, 1000000),
  max_pipelines: byPlan(1, 3, 15, null),
  max_custom_fields_per_object: byPlan(20, 50, 200, 500),
  max_active_automations: byPlan(5, 20, 100, 300),
  max_automation_runs_per_month: byPlan(1000, 5000, 50000, 250000),
  max_forms: byPlan(2, 5, null, null),
  storage_gb: byPlan(2, 10, 50, 200),
  audit_log_days: byPlan(30, 30, 365, 730),
  // temporary until an AI provider is chosen
  ai_credits_per_month: byPlan(100, 0, 0, 0),
  ai_credits_per_user_per_month: byPlan(0, 300, 1000, 3000),
  max_pdf_per_month: byPlan(200, 1000, 3000, 10000),
  max_customer_emails_per_month: byPlan(1000, 2000, 5000, 15000),
  max_customer_emails_per_day: byPlan(100, 200, 500, 1500),
  max_products: byPlan(100, 500, 5000, 50000),
  max_booking_pages: byPlan(2, 0, 0, 0),
  max_booking_pages_per_user: byPlan(0, 1, 5, 5),
  max_teams: byPlan(0, 2, null, null),
  max_whatsapp_numbers: byPlan(1, 1, 3, 10),
  view_seats_per_paid_seat: byPlan(0, 0, 1, 1),
  max_custom_reports: byPlan(0, 10, 50, null),
  max_custom_objects: byPlan(0, 0, 3, 20),
  // owner, 13 October 2026 (second decision): wave 2 capabilities not in the pricing table
  max_price_lists: byPlan(1, 3, 20, 100), // besides the default price list
  max_quote_templates: byPlan(3, 10, 50, 200),
  max_segments: byPlan(3, 10, 50, 200),
  max_qr_codes: byPlan(5, 20, 100, 500),
  max_site_widgets: byPlan(1, 3, 10, 50),
  max_business_cards_per_user: byPlan(1, 1, 1, 1),
};

const ALL = byPlan(true, true, true, true);
const BASIC_UP = byPlan(false, true, true, true);
const PRO_UP = byPlan(false, false, true, true);
const BUSINESS = byPlan(false, false, false, true);

const FEATURES: Record<string, Record<SoldPlan, boolean>> = {
  // open in every plan
  quotes: ALL,
  payment_links: ALL,
  balances: ALL,
  booking_page: ALL,
  money_waiting: ALL,
  instant_reply: ALL, // SPD-04
  email_sync: ALL, // email and calendar sync
  whatsapp_inbox: ALL, // messages paid from the wallet
  goals: ALL, // one goal for the business
  // basic and up
  auto_reassign: BASIC_UP, // SPD-03
  orders: BASIC_UP,
  api: BASIC_UP,
  custom_reports: BASIC_UP,
  // pro and up
  dashboards: PRO_UP,
  goals_per_rep: PRO_UP, // a goal per rep and per team
  custom_roles: PRO_UP,
  view_seats: PRO_UP,
  telephony: PRO_UP,
  custom_objects: PRO_UP,
  remove_built_with: PRO_UP,
  booking_team_pages: PRO_UP,
  // business only
  field_permissions: BUSINESS,
  sso: BUSINESS,
  // owner, 13 October 2026 (second decision): wave 2 capabilities not in the pricing table
  products: ALL,
  price_lists: ALL,
  discounts: ALL,
  documents: ALL,
  payments: ALL,
  collection: ALL,
  consents: ALL,
  segments: ALL,
  business_card: ALL,
  qr_codes: ALL,
  site_widget: ALL,
  retention: ALL,
  granular_permissions: PRO_UP,
};

const PRICES: Record<SoldPlan, Omit<PlanValues, "limits" | "features">> = {
  personal: { price_monthly_agorot: 7900, price_annual_agorot: 6900, price_unit: "org", availability: "available", position: 1 },
  basic: { price_monthly_agorot: 8900, price_annual_agorot: 7900, price_unit: "seat", availability: "available", position: 2 },
  pro: { price_monthly_agorot: 13900, price_annual_agorot: 11900, price_unit: "seat", availability: "available", position: 3 },
  business: { price_monthly_agorot: 21900, price_annual_agorot: 18900, price_unit: "seat", availability: "coming_soon", position: 4 },
};

function column<T>(table: Record<string, Record<SoldPlan, T>>, plan: SoldPlan): Record<string, T> {
  return Object.fromEntries(Object.entries(table).map(([key, values]) => [key, values[plan]]));
}

/** Prices, state, limits and flags of every sold plan (the seed of migration plan_pricing). */
export const PLAN_VALUES: Record<SoldPlan, PlanValues> = Object.fromEntries(
  SOLD_PLANS.map((plan) => [plan, { ...PRICES[plan], limits: column(LIMITS, plan), features: column(FEATURES, plan) }]),
) as Record<SoldPlan, PlanValues>;

export const PLAN_LIMIT_KEYS = Object.keys(LIMITS);
export const PLAN_FEATURE_KEYS = Object.keys(FEATURES);

// Keys added since wave 2 (migrations wave2_plan_keys and plan_pricing). A plan that
// does not hold one (a plan added later in the admin panel) gets the most restrictive
// value: the flag off, the quota 0. Older keys keep their old meaning when missing
// (a flag off, a limit unlimited).
const WAVE2_FEATURE_LIST = [
  "products", "price_lists", "discounts", "quotes", "orders", "documents", "payments", "balances", "collection",
  "money_waiting", "consents", "segments", "goals", "granular_permissions", "booking_page", "business_card", "qr_codes",
  "site_widget", "retention", "remove_built_with", "payment_links", "instant_reply", "auto_reassign", "dashboards",
  "goals_per_rep", "booking_team_pages",
] as const;
const WAVE2_LIMIT_LIST = [
  "max_products", "max_price_lists", "max_quote_templates", "max_booking_pages", "max_booking_pages_per_user",
  "max_segments", "max_qr_codes", "max_pdf_per_month", "max_customer_emails_per_month", "max_customer_emails_per_day",
  "max_custom_reports", "max_custom_objects", "max_teams", "max_whatsapp_numbers", "view_seats_per_paid_seat",
  "max_site_widgets", "max_business_cards_per_user",
] as const;

export type Wave2FeatureKey = (typeof WAVE2_FEATURE_LIST)[number];
export type Wave2LimitKey = (typeof WAVE2_LIMIT_LIST)[number];
export const WAVE2_FEATURE_KEYS: readonly Wave2FeatureKey[] = WAVE2_FEATURE_LIST;
export const WAVE2_LIMIT_KEYS: readonly Wave2LimitKey[] = WAVE2_LIMIT_LIST;

/** app.plan_key_defaults(): the value of a wave 2 key a plan does not hold. */
export const PLAN_KEY_FALLBACK = {
  features: Object.fromEntries(WAVE2_FEATURE_LIST.map((key) => [key, false])) as Record<Wave2FeatureKey, boolean>,
  limits: Object.fromEntries(WAVE2_LIMIT_LIST.map((key) => [key, 0])) as Record<Wave2LimitKey, number>,
};

/**
 * The flag that hides the "נבנה ב-Mexuz" line on customer-facing pages. A business in
 * its trial keeps the line whatever its plan says; an override decides alone
 * (app.show_built_with, migration plan_trial_built_with).
 */
export const REMOVE_BUILT_WITH: Wave2FeatureKey = "remove_built_with";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

/**
 * The effective flag, as app.org_has_feature() decides it: the organization's
 * override, else the plan's value, else (a wave 2 key the plan does not hold) the
 * fallback; anything but true is off.
 */
export function effectiveFeature(key: string, planFeatures: unknown, overrides: unknown): boolean {
  const own = asObject(overrides);
  if (key in own) return own[key] === true;
  const plan = asObject(planFeatures);
  if (key in plan) return plan[key] === true;
  return (PLAN_KEY_FALLBACK.features as JsonObject)[key] === true;
}

/**
 * The effective limits, as app.org_limit() decides them: the fallback, then the
 * plan's keys, then the overrides (a present key wins, null = unlimited).
 */
export function effectiveLimits(planLimits: unknown, overrides: unknown): JsonObject {
  return { ...PLAN_KEY_FALLBACK.limits, ...asObject(planLimits), ...asObject(overrides) };
}

/**
 * A business's allowance for a quota that has a business-wide key and/or a per-user
 * key (see the rule at the top): business-wide + per user x paid seats. null when
 * either part is null (no cap). A missing part counts as 0.
 */
export function orgAllowance(limits: JsonObject, orgKey: string | null, perUserKey: string | null, paidSeats: number): number | null {
  const part = (key: string | null) => (key === null || !(key in limits) ? 0 : limits[key]);
  const org = part(orgKey);
  const perUser = part(perUserKey);
  if (org === null || perUser === null) return null;
  return Number(org) + Number(perUser) * Math.max(0, paidSeats);
}
