import { formatNumber } from "@/lib/format";

import { PLAN_CAPABILITIES, type PlanCapability } from "./capabilities";

/**
 * LND-13 / WEB-01 (owner, 11 November 2026): the landing page's price list comes from the plans table, never typed by hand,
 * through public.plans_public() (anon, migration plans_public): available and coming-soon plans only, with their public
 * fields. This file is the shape of that answer and how the page turns it into lines; no database access here.
 */

/** The cache tag of the landing page's read; the platform's plan actions expire it after a change. */
export const PLANS_PUBLIC_CACHE_TAG = "plans-public";

export type PublicPlan = {
  key: string;
  name: string;
  priceMonthlyAgorot: number;
  priceAnnualAgorot: number;
  priceUnit: "org" | "seat";
  availability: "available" | "coming_soon";
  position: number;
  /** max_users, max_records, storage_gb: a number, null = no cap; a key the plan does not hold is absent */
  limits: Partial<Record<QuotaKey, number | null>>;
  /** the flags that are on */
  features: string[];
};

const QUOTA_KEYS = ["max_users", "max_records", "storage_gb"] as const;
type QuotaKey = (typeof QUOTA_KEYS)[number];

const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The fields public.plans_public() answers per plan; any other field means another shape. */
const PLAN_FIELDS = new Set([
  "key",
  "name",
  "price_monthly_agorot",
  "price_annual_agorot",
  "price_unit",
  "availability",
  "position",
  "limits",
  "features",
]);

function parsePlan(value: unknown): PublicPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((field) => !PLAN_FIELDS.has(field))) return null;
  if (typeof v.key !== "string" || v.key === "" || typeof v.name !== "string" || v.name === "") return null;
  if (!whole(v.price_monthly_agorot) || !whole(v.price_annual_agorot) || !Number.isSafeInteger(v.position)) return null;
  if (v.price_unit !== "org" && v.price_unit !== "seat") return null;
  if (v.availability !== "available" && v.availability !== "coming_soon") return null;
  if (!Array.isArray(v.features) || !v.features.every((f) => typeof f === "string")) return null;
  if (!v.limits || typeof v.limits !== "object" || Array.isArray(v.limits)) return null;
  const rawLimits = v.limits as Record<string, unknown>;
  if (Object.keys(rawLimits).some((key) => !(QUOTA_KEYS as readonly string[]).includes(key))) return null;
  const limits: PublicPlan["limits"] = {};
  for (const key of QUOTA_KEYS) {
    if (!(key in rawLimits)) continue;
    const limit = rawLimits[key];
    if (limit !== null && !whole(limit)) return null;
    limits[key] = limit;
  }
  return {
    key: v.key,
    name: v.name,
    priceMonthlyAgorot: v.price_monthly_agorot,
    priceAnnualAgorot: v.price_annual_agorot,
    priceUnit: v.price_unit,
    availability: v.availability,
    position: v.position as number,
    limits,
    features: v.features as string[],
  };
}

/** public.plans_public()'s answer, or null when its shape is not what the function returns (the page then shows no prices). */
export function parsePublicPlans(data: unknown): PublicPlan[] | null {
  if (!Array.isArray(data)) return null;
  const plans = data.map(parsePlan);
  if (!plans.every((plan): plan is PublicPlan => plan !== null)) return null;
  // the key is the table's primary key: a repeated one is another shape
  return new Set(plans.map((plan) => plan.key)).size === plans.length ? plans : null;
}

/** The read as the cache stores it: any other shape throws, so it is never cached. */
export function publicPlansOrThrow(data: unknown): PublicPlan[] {
  const plans = parsePublicPlans(data);
  if (!plans) throw new Error("plans_public: unexpected answer");
  return plans;
}

/** The quota lines a plan card shows (the same words as the app's plan cards). */
export function planQuotaLines(limits: unknown): string[] {
  const all = limits && typeof limits === "object" && !Array.isArray(limits) ? (limits as Record<string, unknown>) : {};
  const of = (key: string): number | null | undefined => {
    const value = all[key];
    return typeof value === "number" ? value : value === null ? null : undefined;
  };
  const users = of("max_users");
  const records = of("max_records");
  const storage = of("storage_gb");
  const lines: string[] = [];
  if (users !== undefined) lines.push(users === null ? "משתמשים בלי תקרה" : `עד ${formatNumber(users)} משתמשים`);
  if (records !== undefined) lines.push(records === null ? "רשומות בלי תקרה" : `עד ${formatNumber(records)} רשומות`);
  if (storage !== undefined && storage !== null) lines.push(`אחסון ${formatNumber(storage)} GB`);
  return lines;
}

/**
 * What the landing page lists for a plan (LND-04: only what works today): the built capabilities its flags turn on. A
 * capability that is not built yet is never listed on the landing page, even when the plan's flag is on.
 */
export function landingPlanCapabilities(features: readonly string[]): PlanCapability[] {
  const on = new Set(features);
  return PLAN_CAPABILITIES.filter((item) => item.built && item.core !== true && on.has(item.feature));
}

/** The built capabilities every plan holds (core), listed once above the plans. */
export function landingCoreCapabilities(): PlanCapability[] {
  return PLAN_CAPABILITIES.filter((item) => item.built && item.core === true);
}
