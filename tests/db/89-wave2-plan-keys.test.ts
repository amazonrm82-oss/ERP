import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WAVE2_FEATURE_KEYS, WAVE2_FEATURES, WAVE2_LIMIT_KEYS, WAVE2_LIMITS } from "@/lib/plan-keys";

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

// Owner, 13 October 2026: every wave 2 module has its own key in plans, on in every
// plan until pricing; count quotas high and temporary; remove_built_with off.
describe("wave 2 plan keys", () => {
  let org: string;
  let otherOrg: string;

  beforeAll(async () => {
    const owner = await createUser("w2-owner");
    org = await createOrg(owner.id);
    const other = await createUser("w2-other");
    otherOrg = await createOrg(other.id, "עסק אחר");
  });

  it("every plan holds every key, with the temporary values", async () => {
    const rows = await plans();
    expect(rows.length).toBeGreaterThan(0);
    for (const plan of rows) {
      for (const key of WAVE2_FEATURE_KEYS) {
        expect(plan.features, `${plan.key}.${key}`).toHaveProperty(key);
        // quotes existed before wave 2 (off on the free plan) and is never overwritten
        if (!(key === "quotes" && plan.key === "free")) {
          expect(plan.features[key], `${plan.key}.${key}`).toBe(WAVE2_FEATURES[key]);
        }
      }
      for (const key of WAVE2_LIMIT_KEYS) {
        expect(plan.limits[key], `${plan.key}.${key}`).toBe(WAVE2_LIMITS[key]);
      }
    }
  });

  it("remove_built_with is off in every plan", async () => {
    for (const plan of await plans()) {
      expect(plan.features.remove_built_with, plan.key).toBe(false);
    }
  });

  it("the older keys are untouched", async () => {
    const pro = (await plans()).find((p) => p.key === "pro");
    expect(pro?.limits.storage_gb).toBe(50);
    expect(pro?.limits.max_users).toBeNull();
    expect(pro?.features.sso).toBe(false);
    const free = (await plans()).find((p) => p.key === "free");
    expect(free?.features.quotes).toBe(false);
  });

  it("an organization gets the plan's values through the access helpers", async () => {
    for (const key of WAVE2_FEATURE_KEYS) {
      expect(await hasFeature(org, key), key).toBe(WAVE2_FEATURES[key]);
    }
    for (const key of WAVE2_LIMIT_KEYS) {
      expect(await limitOf(org, key), key).toBe(WAVE2_LIMITS[key]);
    }
  });

  it("an override turns a feature off, or remove_built_with on, for one organization only", async () => {
    await setOverrides(org, { goals: false, remove_built_with: true }, { max_products: 5 });
    try {
      expect(await hasFeature(org, "goals")).toBe(false);
      expect(await hasFeature(org, "remove_built_with")).toBe(true);
      expect(await limitOf(org, "max_products")).toBe(5);
      expect(await hasFeature(otherOrg, "goals")).toBe(true);
      expect(await hasFeature(otherOrg, "remove_built_with")).toBe(false);
      expect(await limitOf(otherOrg, "max_products")).toBe(100000);
    } finally {
      await setOverrides(org, {});
    }
  });

  it("a plan without a wave 2 key falls back to its default; older keys keep their old meaning", async () => {
    await asAdmin(async (q) => {
      await q("savepoint s");
      await q(
        "update public.plans set features = features - 'goals' - 'remove_built_with' - 'sso', limits = limits - 'max_products' - 'max_records' where key = (select plan_key from public.subscriptions where organization_id = $1)",
        [org],
      );
      const r = (
        await q<{ goals: boolean; built: boolean; sso: boolean; products: string | null; records: string | null }>(
          `select app.org_has_feature($1, 'goals') as goals, app.org_has_feature($1, 'remove_built_with') as built,
                  app.org_has_feature($1, 'sso') as sso, app.org_limit($1, 'max_products') as products,
                  app.org_limit($1, 'max_records') as records`,
          [org],
        )
      ).rows[0];
      expect(r.goals).toBe(true);
      expect(r.built).toBe(false);
      // a missing older feature is off, a missing older limit unlimited (as before)
      expect(r.sso).toBe(false);
      expect(Number(r.products)).toBe(100000);
      expect(r.records).toBeNull();
      // an explicit null limit on a wave 2 key still means unlimited
      await q("update public.plans set limits = limits || '{\"max_products\": null}' where key = (select plan_key from public.subscriptions where organization_id = $1)", [org]);
      expect((await q<{ v: string | null }>("select app.org_limit($1, 'max_products') as v", [org])).rows[0].v).toBeNull();
      await q("rollback to savepoint s");
    });
    expect(await hasFeature(org, "goals")).toBe(true);
  });

  it("seeding again changes nothing and never overwrites a value set on a plan", async () => {
    await asAdmin(async (q) => {
      await q("savepoint s");
      await q("update public.plans set features = features || '{\"goals\": false}', limits = limits || '{\"max_products\": 7}' where key = 'basic'");
      const res = await q(
        `update public.plans p
            set features = (app.plan_key_defaults() -> 'features') || coalesce(p.features, '{}'::jsonb),
                limits = (app.plan_key_defaults() -> 'limits') || coalesce(p.limits, '{}'::jsonb)
          where not (coalesce(p.features, '{}'::jsonb) ?& array(select jsonb_object_keys(app.plan_key_defaults() -> 'features')))
             or not (coalesce(p.limits, '{}'::jsonb) ?& array(select jsonb_object_keys(app.plan_key_defaults() -> 'limits')))`,
      );
      expect(res.rowCount).toBe(0);
      const basic = (await q<Plan>("select key, features, limits from public.plans where key = 'basic'")).rows[0];
      expect(basic.features.goals).toBe(false);
      expect(basic.limits.max_products).toBe(7);
      await q("rollback to savepoint s");
    });
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
    asService(async (q) => (await q<{ v: boolean | null }>("select public.intake_form_built_with($1) as v", [token])).rows[0].v);

  it("is shown by default", async () => {
    expect(await builtWith(form.token)).toBe(true);
  });

  it("is hidden when the organization's override turns remove_built_with on", async () => {
    await setOverrides(org, { remove_built_with: true });
    try {
      expect(await builtWith(form.token)).toBe(false);
    } finally {
      await setOverrides(org, {});
    }
    expect(await builtWith(form.token)).toBe(true);
  });

  it("answers nothing for an unknown or inactive form", async () => {
    expect(await builtWith("0".repeat(32))).toBeNull();
    expect(await builtWith("")).toBeNull();
    await asAdmin((q) => q("update public.forms set is_active = false where id = $1", [form.id]));
    try {
      expect(await builtWith(form.token)).toBeNull();
    } finally {
      await asAdmin((q) => q("update public.forms set is_active = true where id = $1", [form.id]));
    }
  });

  it("is for the server's service role only", async () => {
    expect((await pgError(asAnon((q) => q("select public.intake_form_built_with($1)", [form.token])))).code).toBe("42501");
    const user = await createUser("built-user");
    expect((await pgError(asUser(user.id, (q) => q("select public.intake_form_built_with($1)", [form.token])))).code).toBe("42501");
    const grants = await asAdmin(
      async (q) =>
        (
          await q<{ anon: boolean; auth: boolean; defaults: boolean }>(
            `select has_function_privilege('anon', 'public.intake_form_built_with(text)', 'execute') as anon,
                    has_function_privilege('authenticated', 'public.intake_form_built_with(text)', 'execute') as auth,
                    has_function_privilege('authenticated', 'app.plan_key_defaults()', 'execute') as defaults`,
          )
        ).rows[0],
    );
    expect(grants).toEqual({ anon: false, auth: false, defaults: false });
  });
});
