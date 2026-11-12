import { PLAN_CAPABILITIES } from "@/features/plans/capabilities";
import { landingCoreCapabilities, planQuotaLines, type PublicPlan } from "@/features/plans/public-plans";
import { formatNumber } from "@/lib/format";
import { PLAN_VALUES, SOLD_PLANS, type SoldPlan } from "@/lib/plan-keys";

/**
 * LND-20 v2 (6): the price cards and the comparison table of the landing page. Prices, quotas and the BUILT capabilities come
 * from public.plans_public (LND-13); a capability that is not built yet comes from PLAN_VALUES (the seed of the plans table,
 * src/lib/plan-keys.ts) and is marked "בקרוב" by the one `built` flag of PLAN_CAPABILITIES; a built one that still waits for its
 * real provider (owner (339) ב, `waiting`, from provider-readiness.ts) is marked too. The annual price is the plans table's own
 * annual price (owner (338) ב). Each plan's unit follows its own price_unit. Pure, so it is unit-tested.
 */

/** The plan marked "מומלצת" (owner: "מקצועית — מומלצת"). The plans table has no field for it, so it is named by its key. */
export const HIGHLIGHTED_PLAN_KEY = "pro";

/** The words after a price, by the plan's own price_unit: per business ("לחודש") or per user ("למשתמש / חודש"). */
export const PRICE_UNITS = {
  org: { month: "לחודש", year: "לשנה" },
  seat: { month: "למשתמש / חודש", year: "למשתמש לשנה" },
} as const satisfies Record<PublicPlan["priceUnit"], { month: string; year: string }>;

export type PriceUnit = (typeof PRICE_UNITS)[keyof typeof PRICE_UNITS];

/** DRAFT (the prototype's): one sentence per plan, by key. A plan without one shows none. */
export const PLAN_SENTENCES: Record<string, string> = {
  personal: "לעצמאי שרוצה סדר בלידים ובלקוחות.",
  basic: "לצוות קטן שמחלק לידים ועובד יחד.",
  pro: "לעסק שמוכר, גובה ומנהל צוותים.",
  business: "לעסק גדול עם כמה סניפים.",
};

export const SOON_LINE = '"בקרוב" = נפתח בשבועות הקרובים, בלי תוספת מחיר.';

export type PlanLine = { label: string; soon: boolean; intro?: boolean };

export type PlanCardData = {
  key: string;
  name: string;
  soon: boolean;
  highlighted: boolean;
  monthlyAgorot: number;
  /** the month's price with annual billing: price_annual_agorot of the plans table */
  annualAgorot: number;
  /** a year's payment with annual billing (12 x the annual month price) */
  annualYearAgorot: number;
  unit: PriceUnit;
  sentence: string | null;
  /** four lines for the front */
  highlights: PlanLine[];
  /** the back: everything (the first plan), else "everything in X, and:" with what this plan adds */
  full: PlanLine[];
};

const isSold = (key: string): key is SoldPlan => (SOLD_PLANS as readonly string[]).includes(key);

/** Every non-core capability a plan holds, in PLAN_CAPABILITIES' order: built ones from the database answer, the others
 * from PLAN_VALUES, marked soon. */
export function planCapabilityLines(plan: PublicPlan, waiting: ReadonlySet<string> = new Set()): PlanLine[] {
  const on = new Set(plan.features);
  const seeded = isSold(plan.key) ? PLAN_VALUES[plan.key].features : {};
  return PLAN_CAPABILITIES.filter((c) => c.core !== true && (c.built ? on.has(c.feature) : seeded[c.feature] === true)).map((c) => ({
    label: c.label,
    soon: !c.built || waiting.has(c.feature),
  }));
}

export function planCards(plans: readonly PublicPlan[], waiting: ReadonlySet<string> = new Set()): PlanCardData[] {
  return plans.map((plan, i) => {
    const prev = i > 0 ? plans[i - 1] : null;
    const quota = planQuotaLines(plan.limits).map((label) => ({ label, soon: false }));
    const caps = planCapabilityLines(plan, waiting);
    let highlights: PlanLine[];
    let full: PlanLine[];
    if (!prev) {
      highlights = [...quota.slice(0, 1), ...caps].slice(0, 4);
      full = [...quota, ...caps];
    } else {
      const prevQuota = new Set(planQuotaLines(prev.limits));
      const prevCaps = new Set(planCapabilityLines(prev, waiting).map((c) => c.label));
      const newQuota = quota.filter((q) => !prevQuota.has(q.label));
      const added = caps.filter((c) => !prevCaps.has(c.label));
      const intro = { label: `כל מה שב${prev.name}`, soon: false };
      highlights = [...newQuota.slice(0, 1), ...added, ...newQuota.slice(1), intro].slice(0, 4);
      full = [{ label: `כל מה שב${prev.name}, ועוד:`, soon: false, intro: true }, ...quota, ...added];
    }
    const soon = plan.availability === "coming_soon";
    if (soon) full.push({ label: "החבילה עוד לא פתוחה להצטרפות", soon: false });
    return {
      key: plan.key,
      name: plan.name,
      soon,
      highlighted: plan.key === HIGHLIGHTED_PLAN_KEY,
      monthlyAgorot: plan.priceMonthlyAgorot,
      annualAgorot: plan.priceAnnualAgorot,
      annualYearAgorot: plan.priceAnnualAgorot * 12,
      unit: PRICE_UNITS[plan.priceUnit] ?? PRICE_UNITS.org,
      sentence: PLAN_SENTENCES[plan.key] ?? null,
      highlights,
      full,
    };
  });
}

export type ComparisonCell = { kind: "yes" } | { kind: "no" } | { kind: "text"; text: string };
export type ComparisonRow = { key: string; label: string; soon: boolean; cells: ComparisonCell[] };

const QUOTA_ROWS = [
  { key: "max_users", label: "משתמשים", unit: "" },
  { key: "max_records", label: "רשומות", unit: "" },
  { key: "storage_gb", label: "אחסון", unit: "GB" },
] as const;

/** A price with its plan's unit: "79 ₪ לחודש", "119 ₪ למשתמש / חודש". */
export function priceText(agorot: number, unit: string): string {
  return `${formatNumber(Math.round(agorot / 100))} ₪ ${unit}`;
}

/** The full table: the two prices (each in its plan's own unit), the three quotas, then every non-core capability any shown
 * plan holds (SMS with its month quota). */
export function comparisonRows(plans: readonly PublicPlan[], waiting: ReadonlySet<string> = new Set()): ComparisonRow[] {
  const rows: ComparisonRow[] = [];
  const unit = (plan: PublicPlan) => PRICE_UNITS[plan.priceUnit] ?? PRICE_UNITS.org;
  rows.push({
    key: "price_monthly",
    label: "מחיר בתשלום חודשי",
    soon: false,
    cells: plans.map((plan): ComparisonCell => ({ kind: "text", text: priceText(plan.priceMonthlyAgorot, unit(plan).month) })),
  });
  rows.push({
    key: "price_annual",
    label: "מחיר בתשלום שנתי",
    soon: false,
    cells: plans.map((plan): ComparisonCell => ({ kind: "text", text: priceText(plan.priceAnnualAgorot, unit(plan).month) })),
  });
  for (const quota of QUOTA_ROWS) {
    if (!plans.some((plan) => quota.key in plan.limits)) continue;
    rows.push({
      key: quota.key,
      label: quota.label,
      soon: false,
      cells: plans.map((plan): ComparisonCell => {
        if (!(quota.key in plan.limits)) return { kind: "no" };
        const value = plan.limits[quota.key];
        return { kind: "text", text: value === null || value === undefined ? "ללא תקרה" : `${formatNumber(value)}${quota.unit}` };
      }),
    });
  }
  const held = plans.map((plan) => new Set(planCapabilityLines(plan, waiting).map((c) => c.label)));
  for (const capability of PLAN_CAPABILITIES) {
    if (capability.core === true || !held.some((set) => set.has(capability.label))) continue;
    rows.push({
      key: capability.feature,
      label: capability.label,
      soon: !capability.built || waiting.has(capability.feature),
      cells: plans.map((plan, i): ComparisonCell => {
        if (!held[i].has(capability.label)) return { kind: "no" };
        if (capability.feature === "sms" && isSold(plan.key)) {
          const quota = PLAN_VALUES[plan.key].limits.max_sms_per_month;
          if (typeof quota === "number" && quota > 0) return { kind: "text", text: formatNumber(quota) };
        }
        return { kind: "yes" };
      }),
    });
  }
  return rows;
}

/** The line under the price list: what "בקרוב" means (only while a tag shows) and what every plan holds. */
export function pricingFootnote(showsSoon = true): string {
  const core = landingCoreCapabilities().map((c) => c.label);
  return `${showsSoon ? `${SOON_LINE} ` : ""}בכל החבילות: ${core.join(", ")}. חוק הפרטיות לא תלוי בחבילה.`;
}

/** Whether any card or row of the price list carries "בקרוב". */
export function pricingShowsSoon(cards: readonly PlanCardData[], rows: readonly ComparisonRow[]): boolean {
  return rows.some((row) => row.soon) || cards.some((card) => [...card.highlights, ...card.full].some((line) => line.soon));
}
