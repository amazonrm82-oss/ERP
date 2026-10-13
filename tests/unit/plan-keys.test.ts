import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BuiltWithLine } from "@/features/built-with/components/built-with-line";
import { builtWithVisible } from "@/features/built-with/visibility";
import { dbErrorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { SUPPORT_LINE } from "@/lib/support-phone";
import { REMOVE_BUILT_WITH, WAVE2_FEATURE_KEYS, WAVE2_FEATURES, WAVE2_LIMIT_KEYS, WAVE2_LIMITS } from "@/lib/plan-keys";

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

describe('the "נבנה ב-Mexuz" line (FLD-04)', () => {
  it("shows only on an explicit true from the database", () => {
    expect(builtWithVisible(true)).toBe(true);
    expect(builtWithVisible(false)).toBe(false);
    expect(builtWithVisible(null)).toBe(false);
    expect(builtWithVisible(undefined)).toBe(false);
    expect(builtWithVisible("true")).toBe(false);
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
