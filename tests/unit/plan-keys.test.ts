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
import { effectiveFeature, effectiveLimits, REMOVE_BUILT_WITH, WAVE2_FEATURE_KEYS, WAVE2_FEATURES, WAVE2_LIMIT_KEYS, WAVE2_LIMITS } from "@/lib/plan-keys";

function migrationDefaults(): { features: Record<string, unknown>; limits: Record<string, unknown> } {
  const dir = join(process.cwd(), "supabase/migrations");
  const file = readdirSync(dir).find((name) => name.endsWith("_wave2_plan_keys.sql"));
  expect(file).toBeDefined();
  const sql = readFileSync(join(dir, file as string), "utf8");
  const json = /select \$json\$([\s\S]*?)\$json\$::jsonb/.exec(sql)?.[1];
  expect(json).toBeDefined();
  return JSON.parse(json as string);
}

describe("wave 2 plan keys (owner, 13 October 2026)", () => {
  it("the TS list equals app.plan_key_defaults() in the migration", () => {
    const db = migrationDefaults();
    expect(db.features).toEqual(WAVE2_FEATURES);
    expect(db.limits).toEqual(WAVE2_LIMITS);
  });

  it("every flag is on except remove_built_with, every count quota is high, and the per-use quotas are the owner's", () => {
    for (const key of WAVE2_FEATURE_KEYS) {
      expect(WAVE2_FEATURES[key]).toBe(key !== REMOVE_BUILT_WITH);
    }
    for (const key of WAVE2_LIMIT_KEYS) {
      const perUse: Record<string, number> = {
        max_pdf_per_month: 1000,
        max_customer_emails_per_month: 1000,
        max_customer_emails_per_day: 100,
      };
      expect(WAVE2_LIMITS[key]).toBe(perUse[key] ?? 100000);
    }
  });

  it("every gate has its own Hebrew message", () => {
    const raised = (hint: string) => dbErrorMessage({ code: "P0001", message: "x", hint });
    const generic = raised("feature:__none__");
    for (const key of WAVE2_FEATURE_KEYS.filter((k) => k !== REMOVE_BUILT_WITH)) {
      expect(raised(`feature:${key}`)).not.toBe(generic);
    }
    const genericLimit = raised("limit:__none__");
    for (const key of WAVE2_LIMIT_KEYS) {
      expect(raised(`limit:${key}`)).not.toBe(genericLimit);
    }
    for (const key of ["max_pdf_per_month", "max_customer_emails_per_month", "max_customer_emails_per_day"]) {
      expect(raised(`limit:${key}`)).toContain(SUPPORT_LINE);
    }
    expect(raised("limit:max_customer_emails_per_day")).toContain("כקישור");
  });
});

describe("effective flags and limits in the app mirror app.org_has_feature / app.org_limit", () => {
  it("override, else plan, else the wave 2 default; older keys missing = off", () => {
    expect(effectiveFeature("goals", {}, {})).toBe(true);
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
    expect(limits.max_price_lists).toBe(100000);
    expect(limits.max_pdf_per_month).toBe(1000);
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
