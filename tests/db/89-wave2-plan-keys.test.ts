import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PLAN_FEATURE_KEYS, PLAN_KEY_FALLBACK, PLAN_LIMIT_KEYS, PLAN_VALUES, SOLD_PLANS } from "@/lib/plan-keys";

import { asAdmin, asAnon, asService, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type Plan = { key: string; features: Record<string, unknown>; limits: Record<string, unknown> };

const plans = () =>
  asAdmin(async (q) => (await q<Plan>("select key, features, limits from public.plans order by position")).rows);
const hasFeature = (org: string, key: string) =>
  asAdmin(async (q) => (await q<{ v: boolean }>("select app.org_has_feature($1, $2) as v", [org, key])).rows[0].v);
const limitOf = (org: string, key: string) =>
  asAdmin(async (q) => {
    const v = (await q<{ v: string | null }>("select app.org_limit($1, $2) as v", [org, key])).rows[0].v;
    return v === null ? null : Number(v);
  });
const setOverrides = (org: string, features: object, limits: object = {}) =>
  asAdmin((q) =>
    q("update public.subscriptions set feature_overrides = $2, limit_overrides = $3 where organization_id = $1", [
      org,
      JSON.stringify(features),
      JSON.stringify(limits),
    ]),
  );

// Owner's pricing of 13 October 2026: every limit and flag is its own key in plans,
// with per-organization overrides; a plan without a wave 2 key gets the most
// restrictive value.
describe("plan keys: limits and flags", () => {
  let org: string;
  let otherOrg: string;

  beforeAll(async () => {
    const owner = await createUser("w2-owner");
    org = await createOrg(owner.id);
    const other = await createUser("w2-other");
    otherOrg = await createOrg(other.id, "עסק אחר");
  });

  it("every sold plan holds every key, with the owner's values", async () => {
    const rows = await plans();
    for (const key of SOLD_PLANS) {
      const plan = rows.find((p) => p.key === key);
      expect(plan, key).toBeDefined();
      for (const limit of PLAN_LIMIT_KEYS) {
        expect(plan?.limits[limit], `${key}.${limit}`).toBe(PLAN_VALUES[key].limits[limit]);
      }
      for (const flag of PLAN_FEATURE_KEYS) {
        expect(plan?.features[flag], `${key}.${flag}`).toBe(PLAN_VALUES[key].features[flag]);
      }
    }
  });

  it("the free plan keeps its own values (quotes off) and its older keys", async () => {
    const free = (await plans()).find((p) => p.key === "free");
    expect(free?.features.quotes).toBe(false);
    expect(free?.limits.max_users).toBe(2);
    expect(free?.limits.storage_gb).toBe(1);
  });

  it("an organization gets its plan's values through the access helpers (a trial is on pro)", async () => {
    const plan = await asAdmin(
      async (q) => (await q<{ plan_key: string }>("select plan_key from public.subscriptions where organization_id = $1", [org])).rows[0].plan_key,
    );
    expect(plan).toBe("pro");
    for (const key of PLAN_FEATURE_KEYS) {
      expect(await hasFeature(org, key), key).toBe(PLAN_VALUES.pro.features[key]);
    }
    for (const key of PLAN_LIMIT_KEYS) {
      expect(await limitOf(org, key), key).toBe(PLAN_VALUES.pro.limits[key]);
    }
    // pro, not business
    expect(await hasFeature(org, "sso")).toBe(false);
    expect(await hasFeature(org, "field_permissions")).toBe(false);
  });

  it("an override changes a flag or a limit for one organization only", async () => {
    await setOverrides(org, { goals: false, remove_built_with: false }, { max_products: 5 });
    try {
      expect(await hasFeature(org, "goals")).toBe(false);
      expect(await hasFeature(org, "remove_built_with")).toBe(false);
      expect(await limitOf(org, "max_products")).toBe(5);
      expect(await hasFeature(otherOrg, "goals")).toBe(true);
      expect(await hasFeature(otherOrg, "remove_built_with")).toBe(true);
      expect(await limitOf(otherOrg, "max_products")).toBe(5000);
    } finally {
      await setOverrides(org, {});
    }
  });

  it("re-running the wave 2 seed only adds missing keys and never overwrites", async () => {
    const dir = join(process.cwd(), "supabase/migrations");
    const file = readdirSync(dir).find((name) => name.endsWith("_wave2_plan_keys.sql"));
    const sql = readFileSync(join(dir, file as string), "utf8");
    const seed = /^update public\.plans p[\s\S]*?;$/m.exec(sql)?.[0];
    expect(seed).toBeDefined();
    await asAdmin(async (q) => {
      await q("savepoint s");
      await q("update public.plans set features = features - 'goals', limits = (limits - 'max_products') || '{\"max_qr_codes\": 7}' where key = 'basic'");
      // basic, and the free plan, which never got the keys added after wave 2
      const res = await q(seed as string);
      expect(res.rowCount).toBe(2);
      const basic = (await q<Plan>("select key, features, limits from public.plans where key = 'basic'")).rows[0];
      // added back, with the fallback value of the day
      expect(basic.features).toHaveProperty("goals");
      expect(basic.limits).toHaveProperty("max_products");
      // a value set on the plan is kept
      expect(basic.limits.max_qr_codes).toBe(7);
      expect(basic.limits.max_records).toBe(PLAN_VALUES.basic.limits.max_records);
      expect((await q(seed as string)).rowCount).toBe(0);
      await q("rollback to savepoint s");
    });
  });

  it("a plan without a wave 2 key gets the most restrictive value; older keys keep their old meaning", async () => {
    expect(PLAN_KEY_FALLBACK.features.goals).toBe(false);
    await asAdmin(async (q) => {
      await q("savepoint s");
      await q(
        "update public.plans set features = features - 'goals' - 'remove_built_with' - 'sso', limits = limits - 'max_products' - 'max_records' where key = 'pro'",
      );
      const r = (
        await q<{ goals: boolean; built: boolean; sso: boolean; products: string | null; records: string | null }>(
          `select app.org_has_feature($1, 'goals') as goals, app.org_has_feature($1, 'remove_built_with') as built,
                  app.org_has_feature($1, 'sso') as sso, app.org_limit($1, 'max_products') as products,
                  app.org_limit($1, 'max_records') as records`,
          [org],
        )
      ).rows[0];
      expect(r.goals).toBe(false);
      expect(r.built).toBe(false);
      // the AI quotas too (missing = 0, as orgAllowance counts it)
      await q("update public.plans set limits = limits - 'ai_credits_per_user_per_month' where key = 'pro'");
      expect(Number((await q<{ v: string }>("select app.org_limit($1, 'ai_credits_per_user_per_month') as v", [org])).rows[0].v)).toBe(0);
      expect(r.sso).toBe(false);
      expect(Number(r.products)).toBe(0);
      // a missing older limit is unlimited (as before)
      expect(r.records).toBeNull();
      // an explicit null limit on a wave 2 key still means unlimited
      await q("update public.plans set limits = limits || '{\"max_products\": null}' where key = 'pro'");
      expect((await q<{ v: string | null }>("select app.org_limit($1, 'max_products') as v", [org])).rows[0].v).toBeNull();
      await q("rollback to savepoint s");
    });
    expect(await hasFeature(org, "goals")).toBe(true);
  });
});

describe('the "נבנה ב-Mexuz" line on the public form (FLD-04)', () => {
  let org: string;
  let form: { id: string; token: string };

  beforeAll(async () => {
    const owner = await createUser("built-owner");
    org = await createOrg(owner.id);
    form = await asUser(owner.id, async (q) =>
      (await q<{ id: string; token: string }>("insert into public.forms (organization_id, name, title) values ($1, 'נבנה', 'פנייה') returning id, token", [org])).rows[0],
    );
  });

  const builtWith = (token: string) =>
    asService(async (q) => (await q<{ r: { built_with: boolean } | null }>("select public.intake_form($1) as r", [token])).rows[0].r?.built_with ?? null);
  const setPlan = (plan: string, status = "trialing") =>
    asAdmin((q) => q("update public.subscriptions set plan_key = $2, status = $3 where organization_id = $1", [org, plan, status]));

  it("a business in its trial keeps the line, even on pro (owner, 13 October 2026)", async () => {
    const sub = await asAdmin(
      async (q) => (await q<{ plan_key: string; status: string }>("select plan_key, status from public.subscriptions where organization_id = $1", [org])).rows[0],
    );
    expect(sub).toEqual({ plan_key: "pro", status: "trialing" });
    expect(await builtWith(form.token)).toBe(true);
  });

  it("a paid subscription follows its plan: hidden on pro and business, shown on personal and basic", async () => {
    try {
      for (const status of ["active", "past_due"]) {
        for (const plan of SOLD_PLANS) {
          await setPlan(plan, status);
          expect(await builtWith(form.token), `${plan} ${status}`).toBe(!PLAN_VALUES[plan].features.remove_built_with);
        }
      }
      await setPlan("pro", "active");
      expect(await builtWith(form.token)).toBe(false);
      await setPlan("basic", "active");
      expect(await builtWith(form.token)).toBe(true);
    } finally {
      await setPlan("pro");
    }
  });

  it("an override decides alone, in the trial or not", async () => {
    try {
      await setOverrides(org, { remove_built_with: true });
      expect(await builtWith(form.token)).toBe(false);
      await setPlan("pro", "active");
      await setOverrides(org, { remove_built_with: false });
      expect(await builtWith(form.token)).toBe(true);
    } finally {
      await setOverrides(org, {});
      await setPlan("pro");
    }
  });

  it("a bad value never fails the form; the line then shows", async () => {
    await setOverrides(org, { remove_built_with: "maybe" });
    try {
      const err = await pgError(asAdmin((q) => q("select app.org_has_feature($1, 'remove_built_with')", [org])));
      expect(err.code).toBe("22P02");
      expect(await builtWith(form.token)).toBe(true);
    } finally {
      await setOverrides(org, {});
    }
  });

  it("nothing for an unknown or inactive form, and only for the service role", async () => {
    expect(await builtWith("0".repeat(32))).toBeNull();
    await asAdmin((q) => q("update public.forms set is_active = false where id = $1", [form.id]));
    try {
      expect(await builtWith(form.token)).toBeNull();
    } finally {
      await asAdmin((q) => q("update public.forms set is_active = true where id = $1", [form.id]));
    }
    expect((await pgError(asAnon((q) => q("select public.intake_form($1)", [form.token])))).code).toBe("42501");
    const grants = await asAdmin(
      async (q) =>
        (
          await q<{ defaults: boolean; built: boolean; old: boolean }>(
            `select has_function_privilege('authenticated', 'app.plan_key_defaults()', 'execute') as defaults,
                    has_function_privilege('authenticated', 'app.show_built_with(uuid)', 'execute') as built,
                    exists (select 1 from pg_proc where proname = 'intake_form_built_with') as old`,
          )
        ).rows[0],
    );
    expect(grants).toEqual({ defaults: false, built: false, old: false });
  });
});
