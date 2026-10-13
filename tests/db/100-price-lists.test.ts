import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

// PL-01: further price lists (name, valid from a date to a date, active), with the plan's
// capability 'price_lists' and quota max_price_lists. The default list is the product's price, not a row.
describe("price lists (PL-01)", () => {
  let owner: U, owner2: U, member: U;
  let org: string, other: string;

  const insert = (userId: string, values: Record<string, unknown>, o = org) =>
    asUser(userId, async (q) => {
      const keys = Object.keys(values);
      const sql = `insert into public.price_lists (organization_id, ${keys.join(", ")}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}) returning id`;
      return (await q<{ id: string }>(sql, [o, ...keys.map((k) => values[k])])).rows[0].id;
    });
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
      return u.usage.find((row) => row.key === "max_price_lists");
    });

  beforeAll(async () => {
    owner = await createUser("pl-owner");
    owner2 = await createUser("pl-owner2");
    org = await createOrg(owner.id);
    other = await createOrg(owner2.id, "עסק אחר");
    member = await addMember(org, owner.id, "member", "pl-member");
  });

  it("a new business has no price lists (business data, not a managed list)", async () => {
    expect(await asAdmin((q) => count(q, "select 1 from public.price_lists where organization_id = $1", [org]))).toBe(0);
  });

  it("stores name, dates and active, with sensible defaults; members read", async () => {
    const id = await insert(owner.id, { name: "סיטונאים", valid_from: "2026-01-01", valid_to: "2026-12-31" });
    const row = await asUser(member.id, async (q) => (await q<Record<string, unknown>>("select name, is_active, to_char(valid_from, 'YYYY-MM-DD') as f, to_char(valid_to, 'YYYY-MM-DD') as t from public.price_lists where id = $1", [id])).rows[0]);
    expect(row).toEqual({ name: "סיטונאים", is_active: true, f: "2026-01-01", t: "2026-12-31" });
    // open-ended both ways
    expect(await insert(owner.id, { name: "בלי תאריכים" })).toBeTruthy();
  });

  it("refuses an end before the start, an empty or untrimmed name, and the same name twice (ignoring case)", async () => {
    expect((await pgError(insert(owner.id, { name: "הפוך", valid_from: "2026-05-02", valid_to: "2026-05-01" }))).code).toBe("23514");
    // a one-day list is fine
    expect(await insert(owner.id, { name: "יום אחד", valid_from: "2026-05-01", valid_to: "2026-05-01" })).toBeTruthy();
    expect((await pgError(insert(owner.id, { name: "" }))).code).toBe("23514");
    expect((await pgError(insert(owner.id, { name: " רווח " }))).code).toBe("23514");
    await insert(owner.id, { name: "Retail" });
    expect((await pgError(insert(owner.id, { name: "retail" }))).code).toBe("23505");
    // the same name in another business is fine
    expect(await insert(owner2.id, { name: "Retail" }, other)).toBeTruthy();
  });

  it("only owners and admins of a writable business write; a read-only business keeps reading", async () => {
    expect((await pgError(insert(member.id, { name: "של חבר צוות" }))).code).toBe("42501");
    const frozenOwner = await createUser("pl-frozen");
    const frozen = await createOrg(frozenOwner.id, "עסק בקריאה בלבד");
    const id = await insert(frozenOwner.id, { name: "לפני ההקפאה" }, frozen);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [frozen]));
    expect((await pgError(insert(frozenOwner.id, { name: "אחרי" }, frozen))).code).toBe("42501");
    await asUser(frozenOwner.id, async (q) => {
      expect((await q("update public.price_lists set is_active = false where id = $1", [id])).rowCount).toBe(0);
      expect((await q("delete from public.price_lists where id = $1", [id])).rowCount).toBe(0);
      expect(await count(q, "select 1 from public.price_lists where id = $1", [id])).toBe(1);
    });
  });

  it("organization_id is fixed once inserted, and only the listed columns are writable", async () => {
    const id = await insert(owner.id, { name: "קבוע" });
    expect((await pgError(asUser(owner.id, (q) => q("update public.price_lists set organization_id = $2 where id = $1", [id, other])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("update public.price_lists set created_at = now() where id = $1", [id])))).code).toBe("42501");
  });

  it("every change is audited", async () => {
    const id = await insert(owner.id, { name: "נבדק" });
    await asUser(owner.id, (q) => q("update public.price_lists set valid_to = '2027-01-01' where id = $1", [id]));
    const actions = await asAdmin(async (q) =>
      (await q<{ action: string }>("select action from public.audit_log where entity_type = 'price_lists' and entity_id = $1 order by created_at, id", [id])).rows.map((r) => r.action),
    );
    expect(actions).toEqual(["insert", "update"]);
  });

  it("every sold plan holds the capability and a quota", async () => {
    const plans = await asAdmin(
      async (q) =>
        (await q<{ key: string; f: boolean; l: string }>(
          "select key, (features->>'price_lists')::boolean as f, limits->>'max_price_lists' as l from public.plans where availability <> 'hidden' order by key",
        )).rows,
    );
    expect(plans.length).toBeGreaterThan(0);
    for (const p of plans) {
      expect(p.f, p.key).toBe(true);
      expect(Number(p.l), p.key).toBeGreaterThan(0);
    }
  });

  it("counts active and inactive lists, refuses the one over the quota, and removing a list frees a place", async () => {
    const used = (await usage(owner.id))!.used;
    await setOverrides(org, { max_price_lists: used + 1 });
    const inactive = await insert(owner.id, { name: "לא פעיל", is_active: false });
    const err = await pgError(insert(owner.id, { name: "מעבר למכסה" }));
    expect(err.code).toBe("P0001");
    expect(err.hint).toBe("limit:max_price_lists");
    expect(await usage(owner.id)).toEqual({ key: "max_price_lists", limit: used + 1, used: used + 1 });
    // another business is not affected
    // another business counts only its own lists (it holds one)
    await setOverrides(other, { max_price_lists: 2 });
    expect(await insert(owner2.id, { name: "של עסק אחר" }, other)).toBeTruthy();
    await setOverrides(other, {});
    await asUser(owner.id, (q) => q("delete from public.price_lists where id = $1", [inactive]));
    expect(await insert(owner.id, { name: "במקום" })).toBeTruthy();
  });

  it("the plan's own value applies without an override", async () => {
    await setOverrides(org, {});
    const planLimit = await asAdmin(
      async (q) =>
        (await q<{ l: string }>(
          "select p.limits->>'max_price_lists' as l from public.subscriptions s join public.plans p on p.key = s.plan_key where s.organization_id = $1",
          [org],
        )).rows[0].l,
    );
    expect((await usage(owner.id))?.limit).toBe(Number(planLimit));
  });

  it("two inserts at the last place: exactly one gets in", async () => {
    const used = (await usage(owner.id))!.used;
    await setOverrides(org, { max_price_lists: used + 1 });
    const results = await Promise.allSettled([insert(owner.id, { name: "מקביל 1" }), insert(owner.id, { name: "מקביל 2" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as { hint?: string }).hint).toBe("limit:max_price_lists");
    await setOverrides(org, {});
  });

  it("without the 'price_lists' capability nothing can be added, also not by the server; what exists stays readable", async () => {
    await setOverrides(org, {}, { price_lists: false });
    const err = await pgError(insert(owner.id, { name: "בלי יכולת" }));
    expect(err.code).toBe("P0001");
    expect(err.hint).toBe("feature:price_lists");
    const serverErr = await pgError(asAdmin((q) => q("insert into public.price_lists (organization_id, name) values ($1, 'שרת')", [org])));
    expect(serverErr.hint).toBe("feature:price_lists");
    expect(await asUser(owner.id, (q) => count(q, "select 1 from public.price_lists where organization_id = $1", [org]))).toBeGreaterThan(0);
    await setOverrides(org, {});
  });

  it("an outsider or a member gets a plain 42501, never the business's plan state", async () => {
    // the capability is off
    await setOverrides(org, {}, { price_lists: false });
    for (const u of [owner2, member]) {
      const err = await pgError(insert(u.id, { name: "בדיקה מבחוץ" }));
      expect(err.code).toBe("42501");
      expect(err.hint ?? null).toBeNull();
    }
    // the business is at its quota
    const used = (await usage(owner.id))!.used;
    await setOverrides(org, { max_price_lists: used });
    expect((await pgError(insert(owner.id, { name: "מעבר" }))).hint).toBe("limit:max_price_lists");
    for (const u of [owner2, member]) {
      const err = await pgError(insert(u.id, { name: "בדיקה מבחוץ" }));
      expect(err.code).toBe("42501");
      expect(err.hint ?? null).toBeNull();
    }
    await setOverrides(org, {});
  });

  it("the insert policy carries the capability too", async () => {
    const check = await asAdmin(
      async (q) =>
        (await q<{ c: string }>("select with_check as c from pg_policies where tablename = 'price_lists' and policyname = 'price_lists_insert'")).rows[0].c,
    );
    expect(check).toContain("org_has_feature");
    expect(check).toContain("'price_lists'");
  });
});
