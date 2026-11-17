// WEB-02: where a business signed up from (LND-14's folded utm_source) and the plan chosen on the landing page's price list,
// read from platform_list_orgs() / platform_org() (app.org_signup_origins, set once when the business was made).

export type SignupOrigin = { source: string | null; planKey: string | null };

const SOURCE_SHAPE = /^[a-z0-9_.-]{1,40}$/;
const PLAN_SHAPE = /^[a-z][a-z0-9_]{0,39}$/;

/** The answer's fields read strictly: a source or plan key outside its closed shape is left out. */
export function parseSignupOrigin(source: unknown, planKey: unknown): SignupOrigin {
  return {
    source: typeof source === "string" && SOURCE_SHAPE.test(source) ? source : null,
    planKey: typeof planKey === "string" && PLAN_SHAPE.test(planKey) ? planKey : null,
  };
}

/** The source in Hebrew: none recorded, a visit with no utm_source, an unreadable one, or the source itself. */
export function signupSourceText(source: string | null): string {
  if (source === null) return "לא נרשם";
  if (source === "direct") return "ישירות (בלי מקור)";
  if (source === "other") return "אחר";
  return source;
}

/** The plan chosen on the price list, by its Hebrew name when known; null when none was chosen. */
export function signupPlanText(planKey: string | null, plans: readonly { key: string; name_he: string }[]): string | null {
  if (planKey === null) return null;
  return plans.find((p) => p.key === planKey)?.name_he ?? planKey;
}
