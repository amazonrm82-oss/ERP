import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

// PRD-08: the plan's product quota (max_products) and the 'products' capability.
describe("product quota (PRD-08)", () => {
  let owner: U, owner2: U;
  let org: string, other: string;

  const insert = (userId: string, name: string, o = org) =>
    asUser(userId, async (q) =>
      (await q<{ id: string }>("insert into public.products (organization_id, name) values ($1, $2) returning id", [o, name])).rows[0].id,
    );
  const setOverrides = (o: string, limits: Record<string, unknown>, features: Record<string, unknown> = {}) =>
    asAdmin((q) =>
      q("update public.subscriptions set limit_overrides = $2, feature_overrides = $3 where organization_id = $1", [
        o,
        JSON.stringify(limits),
        JSON.stringify(features),
      ]),
    );
  const usage = (userId: string, o = org) =>
    asUser(userId, async (q) => {
      const u = (await q<{ u: { usage: Array<{ key: string; limit: number | null; used: number }> } }>("select public.org_plan_usage($1) as u", [o])).rows[0].u;
      return u.usage.find((row) => row.key === "max_products");
    });

  beforeAll(async () => {
    owner = await createUser("quota-owner");
    owner2 = await createUser("quota-owner2");
    org = await createOrg(owner.id);
    other = await createOrg(owner2.id, "עסק אחר");
  });

  it("every sold plan holds the capability and a quota", async () => {
    const plans = await asAdmin(
      async (q) =>
        (await q<{ key: string; f: boolean; l: string }>(
          "select key, (features->>'products')::boolean as f, limits->>'max_products' as l from public.plans where availability <> 'hidden' order by key",
        )).rows,
    );
    expect(plans.length).toBeGreaterThan(0);
    for (const p of plans) {
      expect(p.f, p.key).toBe(true);
      expect(Number(p.l), p.key).toBeGreaterThan(0);
    }
  });

  it("counts active, inactive and archived products, and refuses the one over the quota", async () => {
    await setOverrides(org, { max_products: 3 });
    const a = await insert(owner.id, "פעיל");
    const b = await insert(owner.id, "לא פעיל");
    const c = await insert(owner.id, "בארכיון");
    await asUser(owner.id, (q) => q("update public.products set is_active = false where id = $1", [b]));
    await asUser(owner.id, (q) => q("update public.products set archived_at = now() where id = $1", [c]));
    expect(a).toBeTruthy();

    const err = await pgError(insert(owner.id, "רביעי"));
    expect(err.code).toBe("P0001");
    expect(err.hint).toBe("limit:max_products");
    expect(await usage(owner.id)).toEqual({ key: "max_products", limit: 3, used: 3 });

    // another business is not affected
    await setOverrides(other, { max_products: 3 });
    expect(await insert(owner2.id, "של עסק אחר", other)).toBeTruthy();
  });

  it("a per-business override raises the quota, and removing a product frees a place", async () => {
    await setOverrides(org, { max_products: 4 });
    const d = await insert(owner.id, "רביעי");
    expect((await pgError(insert(owner.id, "חמישי"))).hint).toBe("limit:max_products");
    await asUser(owner.id, (q) => q("delete from public.products where id = $1", [d]));
    expect(await insert(owner.id, "חמישי")).toBeTruthy();
    expect(await usage(owner.id)).toEqual({ key: "max_products", limit: 4, used: 4 });
  });

  it("the plan's own value applies without an override", async () => {
    await setOverrides(org, {});
    const planLimit = await asAdmin(
      async (q) =>
        (await q<{ l: string }>(
          "select p.limits->>'max_products' as l from public.subscriptions s join public.plans p on p.key = s.plan_key where s.organization_id = $1",
          [org],
        )).rows[0].l,
    );
    expect((await usage(owner.id))?.limit).toBe(Number(planLimit));
    expect(await insert(owner.id, "שישי")).toBeTruthy();
  });

  it("two inserts at the last place: exactly one gets in", async () => {
    const used = (await usage(owner.id))!.used;
    await setOverrides(org, { max_products: used + 1 });
    const results = await Promise.allSettled([insert(owner.id, "מקביל 1"), insert(owner.id, "מקביל 2")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as { hint?: string }).hint).toBe("limit:max_products");
  });

  it("without the 'products' capability nothing can be added, also not by the server", async () => {
    await setOverrides(org, {}, { products: false });
    const err = await pgError(insert(owner.id, "בלי יכולת"));
    expect(err.code).toBe("P0001");
    expect(err.hint).toBe("feature:products");
    const serverErr = await pgError(
      asAdmin((q) => q("insert into public.products (organization_id, name) values ($1, 'שרת')", [org])),
    );
    expect(serverErr.hint).toBe("feature:products");
    // reading and editing what exists still works
    const n = await asUser(owner.id, async (q) => (await q("select id from public.products where organization_id = $1", [org])).rowCount);
    expect(n).toBeGreaterThan(0);
    await setOverrides(org, {});
  });

  it("the policy carries the capability too", async () => {
    const check = await asAdmin(
      async (q) =>
        (await q<{ c: string }>("select with_check as c from pg_policies where tablename = 'products' and policyname = 'products_insert'")).rows[0].c,
    );
    expect(check).toContain("org_has_feature");
    expect(check).toContain("'products'");
  });
});
