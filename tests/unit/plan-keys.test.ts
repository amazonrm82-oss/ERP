import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BuiltWithLine } from "@/features/built-with/components/built-with-line";
import { builtWithVisible } from "@/features/built-with/visibility";
import { publicFormFrom } from "@/features/intake/public-form";
import { dbErrorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { SUPPORT_LINE } from "@/lib/support-phone";
import {
  effectiveFeature,
  effectiveLimits,
  orgAllowance,
  PLAN_FEATURE_KEYS,
  PLAN_KEY_FALLBACK,
  PLAN_LIMIT_KEYS,
  PLAN_VALUES,
  REMOVE_BUILT_WITH,
  SOLD_PLANS,
  WAVE2_FEATURE_KEYS,
  WAVE2_LIMIT_KEYS,
} from "@/lib/plan-keys";

function migration(suffix: string): string {
  const dir = join(process.cwd(), "supabase/migrations");
  const file = readdirSync(dir).find((name) => name.endsWith(suffix));
  expect(file, suffix).toBeDefined();
  return readFileSync(join(dir, file as string), "utf8");
}

const quoted = (sql: string, tag: string) => {
  const body = new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$::jsonb`).exec(sql)?.[1];
  expect(body, tag).toBeDefined();
  return JSON.parse(body as string);
};

type Values = Record<string, { limits: Record<string, unknown>; features: Record<string, unknown> }>;

describe("plan prices, limits and flags (owner's pricing, 13 October 2026)", () => {
  it("the TS mirror equals the seed with the later changes, and the latest app.plan_key_defaults()", () => {
    const seed = quoted(migration("_plan_pricing.sql"), "seed") as Values;
    // every later change of the plans, in name order (plan_trial_built_with, then a key per capability, e.g. CAP-08)
    for (const suffix of ["_plan_trial_built_with.sql", "_lead_distribution_plan.sql"]) {
      const delta = quoted(migration(suffix), "delta") as Values;
      for (const [plan, change] of Object.entries(delta)) {
        seed[plan].limits = { ...seed[plan].limits, ...change.limits };
        seed[plan].features = { ...seed[plan].features, ...change.features };
      }
    }
    expect(seed).toEqual(PLAN_VALUES);
    // the latest app.plan_key_defaults()
    expect(quoted(migration("_lead_distribution_plan.sql"), "json")).toEqual(PLAN_KEY_FALLBACK);
  });

  it("a wave 2 key a plan does not hold falls back to the most restrictive value", () => {
    expect(Object.keys(PLAN_KEY_FALLBACK.features).sort()).toEqual([...WAVE2_FEATURE_KEYS].sort());
    expect(Object.keys(PLAN_KEY_FALLBACK.limits).sort()).toEqual([...WAVE2_LIMIT_KEYS].sort());
    expect(Object.values(PLAN_KEY_FALLBACK.features).every((v) => v === false)).toBe(true);
    expect(Object.values(PLAN_KEY_FALLBACK.limits).every((v) => v === 0)).toBe(true);
  });

  it("prices: personal per business, the others per user; business coming soon", () => {
    expect(PLAN_VALUES.personal).toMatchObject({ price_monthly_agorot: 7900, price_annual_agorot: 6900, price_unit: "org", availability: "available" });
    expect(PLAN_VALUES.basic).toMatchObject({ price_monthly_agorot: 8900, price_annual_agorot: 7900, price_unit: "seat", availability: "available" });
    expect(PLAN_VALUES.pro).toMatchObject({ price_monthly_agorot: 13900, price_annual_agorot: 11900, price_unit: "seat", availability: "available" });
    expect(PLAN_VALUES.business).toMatchObject({ price_monthly_agorot: 21900, price_annual_agorot: 18900, price_unit: "seat", availability: "coming_soon" });
  });

  it("every sold plan holds every key; a few values per plan", () => {
    for (const plan of SOLD_PLANS) {
      expect(Object.keys(PLAN_VALUES[plan].limits).sort()).toEqual([...PLAN_LIMIT_KEYS].sort());
      expect(Object.keys(PLAN_VALUES[plan].features).sort()).toEqual([...PLAN_FEATURE_KEYS].sort());
    }
    const limit = (key: string) => SOLD_PLANS.map((plan) => PLAN_VALUES[plan].limits[key]);
    const flag = (key: string) => SOLD_PLANS.map((plan) => PLAN_VALUES[plan].features[key]);
    expect(limit("max_users")).toEqual([2, null, null, null]);
    expect(limit("max_teams")).toEqual([0, 2, null, null]);
    expect(limit("ai_credits_per_month")).toEqual([100, 0, 0, 0]);
    expect(limit("ai_credits_per_user_per_month")).toEqual([0, 300, 1000, 3000]);
    expect(limit("max_pdf_per_month")).toEqual([200, 1000, 3000, 10000]);
    expect(limit("max_customer_emails_per_day")).toEqual([100, 200, 500, 1500]);
    expect(limit("view_seats_per_paid_seat")).toEqual([0, 0, 1, 1]);
    expect(limit("max_custom_objects")).toEqual([0, 0, 3, 20]);
    expect(flag("quotes")).toEqual([true, true, true, true]);
    expect(flag("orders")).toEqual([false, true, true, true]);
    expect(flag("remove_built_with")).toEqual([false, false, true, true]);
    expect(flag("sso")).toEqual([false, false, false, true]);
    expect(flag("granular_permissions")).toEqual([false, false, true, true]);
    expect(flag("site_widget")).toEqual([true, true, true, true]);
    expect(limit("max_price_lists")).toEqual([1, 3, 20, 100]);
    expect(limit("max_quote_templates")).toEqual([3, 10, 50, 200]);
    expect(limit("max_segments")).toEqual([3, 10, 50, 200]);
    expect(limit("max_qr_codes")).toEqual([5, 20, 100, 500]);
    expect(limit("max_site_widgets")).toEqual([1, 3, 10, 50]);
    expect(limit("max_business_cards_per_user")).toEqual([1, 1, 1, 1]);
    expect(limit("max_booking_team_pages")).toEqual([0, 0, 10, 50]);
    expect(flag("booking_team_pages")).toEqual([false, false, true, true]);
  });

  it("a per-user quota is multiplied by the paid seats and added to the business-wide one", () => {
    const personal = PLAN_VALUES.personal.limits;
    const pro = PLAN_VALUES.pro.limits;
    expect(orgAllowance(personal, "ai_credits_per_month", "ai_credits_per_user_per_month", 2)).toBe(100);
    expect(orgAllowance(pro, "ai_credits_per_month", "ai_credits_per_user_per_month", 4)).toBe(4000);
    expect(orgAllowance(pro, "max_booking_pages", "max_booking_pages_per_user", 3)).toBe(15);
    expect(orgAllowance({ a: null, b: 1 }, "a", "b", 3)).toBeNull();
  });

  it("every gate has its own Hebrew message", () => {
    const raised = (hint: string) => dbErrorMessage({ code: "P0001", message: "x", hint });
    const generic = raised("feature:__none__");
    for (const key of WAVE2_FEATURE_KEYS.filter((k) => k !== REMOVE_BUILT_WITH)) {
      expect(raised(`feature:${key}`), key).not.toBe(generic);
    }
    const genericLimit = raised("limit:__none__");
    for (const key of WAVE2_LIMIT_KEYS) {
      expect(raised(`limit:${key}`), key).not.toBe(genericLimit);
    }
    for (const key of ["max_pdf_per_month", "max_customer_emails_per_month", "max_customer_emails_per_day", "max_booking_team_pages"]) {
      expect(raised(`limit:${key}`)).toContain(SUPPORT_LINE);
    }
    expect(raised("limit:max_customer_emails_per_day")).toContain("כקישור");
    expect(raised("plan:not_available")).not.toBe(raised("plan:hidden"));
  });
});

describe("effective flags and limits in the app mirror app.org_has_feature / app.org_limit", () => {
  it("override, else plan, else the restrictive fallback; older keys missing = off", () => {
    expect(effectiveFeature("goals", {}, {})).toBe(false);
    expect(effectiveFeature("goals", { goals: true }, {})).toBe(true);
    expect(effectiveFeature("remove_built_with", {}, {})).toBe(false);
    expect(effectiveFeature("goals", { goals: false }, {})).toBe(false);
    expect(effectiveFeature("goals", { goals: false }, { goals: true })).toBe(true);
    expect(effectiveFeature("remove_built_with", {}, { remove_built_with: true })).toBe(true);
    expect(effectiveFeature("view_seats", {}, {})).toBe(false);
    expect(effectiveFeature("view_seats", { view_seats: true }, null)).toBe(true);
    expect(effectiveFeature("goals", null, { goals: null })).toBe(false);
  });

  it("limits: defaults, then the plan, then the overrides; null stays unlimited; older keys missing = absent", () => {
    const limits = effectiveLimits({ max_records: 1000, max_products: null }, { max_qr_codes: 5 });
    expect(limits.max_records).toBe(1000);
    expect(limits.max_products).toBeNull();
    expect(limits.max_qr_codes).toBe(5);
    expect(limits.max_price_lists).toBe(0);
    expect(limits.max_site_widgets).toBe(0);
    expect(limits.max_pdf_per_month).toBe(0);
    expect(limits.max_users).toBeUndefined();
  });
});

describe('the "נבנה ב-Mexuz" line (FLD-04)', () => {
  it("shows only on an explicit true from the database", () => {
    expect(builtWithVisible(true)).toBe(true);
    expect(builtWithVisible(false)).toBe(false);
    expect(builtWithVisible(null)).toBe(false);
    expect(builtWithVisible(undefined)).toBe(false);
    expect(builtWithVisible("true")).toBe(false);
    const base = { title: "t", fields: [] };
    expect(publicFormFrom({ ...base, built_with: true })?.builtWith).toBe(true);
    expect(publicFormFrom({ ...base, built_with: false })?.builtWith).toBe(false);
    expect(publicFormFrom(base)?.builtWith).toBe(false);
  });

  it("links to the landing page in a new tab, with an accessible name", () => {
    const html = renderToStaticMarkup(createElement(BuiltWithLine));
    expect(html).toContain(`href="${paths.landing}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toMatch(/rel="[^"]*noopener[^"]*"/);
    expect(html).toContain("נבנה ב-");
    expect(html).toContain("Mexuz");
    expect(html).toContain("(נפתח בחלון חדש)");
    // design tokens only
    expect(html).toContain("text-caption");
    expect(html).toContain("text-ink-soft");
  });
});
