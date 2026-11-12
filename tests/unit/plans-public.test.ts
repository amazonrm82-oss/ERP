import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PLAN_CAPABILITIES } from "@/features/plans/capabilities";
import {
  landingCoreCapabilities,
  landingPlanCapabilities,
  parsePublicPlans,
  planQuotaLines,
  PLANS_PUBLIC_CACHE_TAG,
  publicPlansOrThrow,
} from "@/features/plans/public-plans";

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8");

const plan = (over: Record<string, unknown> = {}) => ({
  key: "personal",
  name: "אישית",
  price_monthly_agorot: 7900,
  price_annual_agorot: 6900,
  price_unit: "org",
  availability: "available",
  position: 1,
  limits: { max_users: 2, max_records: 10000, storage_gb: 2 },
  features: ["quotes", "api"],
  ...over,
});

describe("LND-13: the landing page's price list", () => {
  it("reads public.plans_public()'s answer", () => {
    expect(parsePublicPlans([plan(), plan({ key: "business", availability: "coming_soon", price_unit: "seat", limits: { max_users: null } })])).toEqual([
      {
        key: "personal",
        name: "אישית",
        priceMonthlyAgorot: 7900,
        priceAnnualAgorot: 6900,
        priceUnit: "org",
        availability: "available",
        position: 1,
        limits: { max_users: 2, max_records: 10000, storage_gb: 2 },
        features: ["quotes", "api"],
      },
      expect.objectContaining({ key: "business", availability: "coming_soon", priceUnit: "seat", limits: { max_users: null } }),
    ]);
    expect(parsePublicPlans([])).toEqual([]);
  });

  it("refuses any other shape, so a bad answer is never cached", () => {
    for (const bad of [
      null,
      {},
      { refused: "rate" },
      [plan({ availability: "hidden" })],
      [plan({ price_unit: "month" })],
      [plan({ price_monthly_agorot: -1 })],
      [plan({ price_monthly_agorot: 1.5 })],
      [plan({ name: "" })],
      [plan({ features: [1] })],
      [plan({ limits: { max_users: "2" } })],
      [plan({ limits: [] })],
      [plan({ position: 1.5 })],
      [plan({ position: Number.NaN })],
      [plan({ position: Number.POSITIVE_INFINITY })],
      [plan({ position: "1" })],
      [plan({ name_en: "Personal" })],
      [plan({ limits: { max_users: 2, ai_credits_per_month: 9 } })],
      [plan(), plan({ position: 2 })],
    ]) {
      expect(parsePublicPlans(bad)).toBeNull();
      expect(() => publicPlansOrThrow(bad)).toThrow();
    }
  });

  it("keeps only the three quota lines and words them as the app's plan cards", () => {
    expect(parsePublicPlans([plan({ limits: { max_users: 2 } })])?.[0].limits).toEqual({ max_users: 2 });
    expect(planQuotaLines({ max_users: 2, max_records: 10000, storage_gb: 2 })).toEqual(["עד 2 משתמשים", "עד 10,000 רשומות", "אחסון 2 GB"]);
    expect(planQuotaLines({ max_users: null, max_records: null, storage_gb: null })).toEqual(["משתמשים בלי תקרה", "רשומות בלי תקרה"]);
    expect(planQuotaLines({})).toEqual([]);
  });

  it("lists only built capabilities (LND-04), the core ones once for every plan", () => {
    const unbuilt = PLAN_CAPABILITIES.filter((c) => !c.built && !c.core).map((c) => c.feature);
    expect(unbuilt.length).toBeGreaterThan(0);
    const listed = landingPlanCapabilities([...PLAN_CAPABILITIES.map((c) => c.feature), "internal_flag"]);
    expect(listed.every((c) => c.built && !c.core)).toBe(true);
    expect(listed.map((c) => c.feature)).not.toContain("internal_flag");
    for (const feature of unbuilt) expect(listed.map((c) => c.feature)).not.toContain(feature);
    expect(landingPlanCapabilities([])).toEqual([]);
    expect(landingCoreCapabilities().every((c) => c.core && c.built)).toBe(true);
    expect(landingCoreCapabilities().length).toBeGreaterThan(0);
  });

  it("public.plans_public()'s closed feature list equals the built, non-core capabilities of capabilities.ts, in order", () => {
    // flipping `built` (or adding a built capability) needs a new migration redefining plans_public and a fresh review
    const files = readdirSync(fileURLToPath(new URL("../../supabase/migrations", import.meta.url)))
      .filter((name) => read(`supabase/migrations/${name}`).includes("function public.plans_public("))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    const latest = read(`supabase/migrations/${files[files.length - 1]}`);
    const block = latest.match(/-- landing-capabilities:[^\n]*\n([\s\S]*?)-- end landing-capabilities/);
    expect(block, "the markers around the SQL array").not.toBeNull();
    const sqlKeys = [...(block?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    const expected = PLAN_CAPABILITIES.filter((c) => c.built && c.core !== true).map((c) => c.feature);
    expect(sqlKeys).toEqual(expected);
  });

  it("the platform's plan actions expire the cache tag the read uses", () => {
    expect(PLANS_PUBLIC_CACHE_TAG).toBe("plans-public");
    const actions = read("src/features/platform/actions.ts");
    for (const name of ["updatePlanAction", "setPlanAvailabilityAction"]) {
      const body = actions.slice(actions.indexOf(`export async function ${name}`));
      const end = body.indexOf("\nexport ", 10);
      expect(body.slice(0, end), name).toContain("updateTag(PLANS_PUBLIC_CACHE_TAG)");
    }
    const server = read("src/features/landing/price-list-server.ts");
    expect(server).toMatch(/tags: \[PLANS_PUBLIC_CACHE_TAG\]/);
    expect(server).toMatch(/revalidate: 3600/);
    expect(server).not.toMatch(/supabase\/service|createServiceClient/);
    expect(read("src/app/page.tsx")).toContain("<PricingSection plans={plans} waiting={waiting} />");
  });
});
