import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asMfaUser, closePool, createOrg, createUser, pgError } from "./helpers";

const staffIds: string[] = [];
afterAll(async () => {
  // other files count the platform owners (the last one cannot step down)
  await asAdmin((q) => q("delete from app.platform_staff where user_id = any($1)", [staffIds]));
  await closePool();
});

const makeStaff = (userId: string, role: string) => {
  staffIds.push(userId);
  return asAdmin((q) => q("insert into app.platform_staff (user_id, role) values ($1, $2) on conflict (user_id) do update set role = excluded.role", [userId, role]));
};

type PlanState = { key: string; price_monthly_agorot: number; price_annual_agorot: number; price_unit: string; availability: string; is_public: boolean; position: number };
const planStates = () =>
  asAdmin(async (q) =>
    (
      await q<PlanState>(
        "select key, price_monthly_agorot, price_annual_agorot, price_unit, availability, is_public, position from public.plans order by position",
      )
    ).rows,
  );
const planOf = (org: string) =>
  asAdmin(async (q) => (await q<{ plan_key: string }>("select plan_key from public.subscriptions where organization_id = $1", [org])).rows[0].plan_key);

function migration(suffix: string): string {
  const dir = join(process.cwd(), "supabase/migrations");
  const file = readdirSync(dir).find((name) => name.endsWith(suffix));
  expect(file).toBeDefined();
  return readFileSync(join(dir, file as string), "utf8");
}

// Owner's pricing of 13 October 2026.
describe("plan prices and states", () => {
  let owner: { id: string };
  let finance: { id: string };
  let support: { id: string };
  let org: string;

  beforeAll(async () => {
    owner = await createUser("pricing-owner");
    await makeStaff(owner.id, "owner");
    finance = await createUser("pricing-finance");
    await makeStaff(finance.id, "finance");
    support = await createUser("pricing-support");
    await makeStaff(support.id, "support");
    const customer = await createUser("pricing-customer");
    org = await createOrg(customer.id);
  });

  it("prices before VAT; personal per business, the others per user; states and order", async () => {
    expect(await planStates()).toEqual([
      { key: "free", price_monthly_agorot: 0, price_annual_agorot: 0, price_unit: "seat", availability: "hidden", is_public: false, position: 0 },
      { key: "personal", price_monthly_agorot: 7900, price_annual_agorot: 6900, price_unit: "org", availability: "available", is_public: true, position: 1 },
      { key: "basic", price_monthly_agorot: 8900, price_annual_agorot: 7900, price_unit: "seat", availability: "available", is_public: true, position: 2 },
      { key: "pro", price_monthly_agorot: 13900, price_annual_agorot: 11900, price_unit: "seat", availability: "available", is_public: true, position: 3 },
      { key: "business", price_monthly_agorot: 21900, price_annual_agorot: 18900, price_unit: "seat", availability: "coming_soon", is_public: false, position: 4 },
    ]);
  });

  it("is_public always follows the availability, whoever writes it", async () => {
    await asAdmin(async (q) => {
      await q("savepoint s");
      await q("update public.plans set is_public = true where key = 'business'");
      expect((await q<{ p: boolean }>("select is_public as p from public.plans where key = 'business'")).rows[0].p).toBe(false);
      await q("update public.plans set availability = 'available' where key = 'business'");
      expect((await q<{ p: boolean }>("select is_public as p from public.plans where key = 'business'")).rows[0].p).toBe(true);
      expect((await pgError(q("update public.plans set availability = 'soon' where key = 'business'"))).code).toBe("23514");
      await q("rollback to savepoint s");
    });
  });

  it("only the platform owner moves a plan between states, and it is logged", async () => {
    const set = (userId: string, availability: string) =>
      asMfaUser(userId, (q) => q("select public.platform_set_plan_availability('business', $1)", [availability]));
    for (const user of [finance, support]) {
      expect((await pgError(set(user.id, "available"))).code).toBe("42501");
    }
    expect((await pgError(set(owner.id, "open"))).code).toBe("22023");
    expect((await pgError(asMfaUser(owner.id, (q) => q("select public.platform_set_plan_availability('nope', 'hidden')")))).code).toBe("P0002");
    await set(owner.id, "available");
    try {
      expect((await planStates()).find((p) => p.key === "business")).toMatchObject({ availability: "available", is_public: true });
      const log = await asAdmin(
        async (q) =>
          (await q<{ details: { key: string; old: string; new: string } }>("select details from app.platform_log where action = 'plan.availability' order by created_at desc limit 1")).rows[0]
            .details,
      );
      expect(log).toEqual({ key: "business", old: "coming_soon", new: "available" });
    } finally {
      await set(owner.id, "coming_soon");
    }
  });

  it("a coming-soon plan cannot be chosen; the current plan can be kept", async () => {
    const update = (planKey: string) =>
      asMfaUser(finance.id, (q) => q("select public.platform_update_subscription($1, $2, null, null, 'בדיקה')", [org, planKey]));
    const err = await pgError(update("business"));
    expect(err.code).toBe("P0001");
    expect(err.hint).toBe("plan:not_available");
    expect((await pgError(update("free"))).hint).toBe("plan:hidden");
    await update("personal");
    expect(await planOf(org)).toBe("personal");
    await asAdmin((q) => q("update public.subscriptions set plan_key = 'business' where organization_id = $1", [org]));
    await update("business");
    expect(await planOf(org)).toBe("business");
    await update("pro");
    expect(await planOf(org)).toBe("pro");
  });

  it("monthly revenue counts a price per business once, a price per user once per seat", async () => {
    const reader = await createUser("pricing-reader");
    await makeStaff(reader.id, "readonly");
    const mrr = async () =>
      Number((await asMfaUser(reader.id, async (q) => (await q<{ r: { mrr_agorot: number } }>("select public.platform_metrics() as r")).rows[0].r)).mrr_agorot);
    const customer = await createUser("pricing-mrr");
    const paying = await createOrg(customer.id);
    const before = await mrr();
    await asAdmin(async (q) => {
      await q("update public.organizations set status = 'active' where id = $1", [paying]);
      await q("update public.subscriptions set plan_key = 'personal', status = 'active', seats = 2, billing_cycle = 'monthly' where organization_id = $1", [paying]);
    });
    try {
      expect((await mrr()) - before).toBe(7900);
      await asAdmin((q) => q("update public.subscriptions set plan_key = 'basic' where organization_id = $1", [paying]));
      expect((await mrr()) - before).toBe(2 * 8900);
    } finally {
      await asAdmin(async (q) => {
        await q("update public.subscriptions set plan_key = 'pro', status = 'trialing', seats = null where organization_id = $1", [paying]);
        await q("update public.organizations set status = 'trial' where id = $1", [paying]);
      });
    }
  });

  it("running the latest migration again changes no row; both again in order end at the same values", async () => {
    const pricing = migration("_plan_pricing.sql");
    const later = migration("_plan_trial_built_with.sql");
    await asAdmin(async (q) => {
      const snapshot = async (withXmin: boolean) => ({
        plans: (await q(`select ${withXmin ? "xmin::text as x, " : ""}* from public.plans order by key`)).rows,
        subscriptions: (await q("select xmin::text as x, * from public.subscriptions order by organization_id")).rows,
      });
      const before = await snapshot(true);
      expect(before.subscriptions.length).toBeGreaterThan(0);
      await q("savepoint s");
      await q(later);
      expect(await snapshot(true)).toEqual(before);
      const values = await snapshot(false);
      // the pricing seed rewrites the later keys and the later migration puts them back
      await q(pricing);
      await q(later);
      expect(await snapshot(false)).toEqual(values);
      await q("rollback to savepoint s");
    });
  });

  it("the second decision changes only its own keys on the sold plans", async () => {
    const sql = migration("_plan_trial_built_with.sql");
    await asAdmin(async (q) => {
      await q("savepoint s");
      await q("update public.plans set limits = limits || '{\"max_records\": 7, \"max_qr_codes\": 7}', features = features || '{\"sso\": true, \"site_widget\": false}' where key = 'basic'");
      await q("update public.plans set limits = limits || '{\"max_qr_codes\": 7}' where key = 'free'");
      await q(sql);
      const basic = (await q<{ l: Record<string, unknown>; f: Record<string, unknown> }>("select limits as l, features as f from public.plans where key = 'basic'")).rows[0];
      expect(basic.l.max_records).toBe(7);
      expect(basic.f.sso).toBe(true);
      expect(basic.l.max_qr_codes).toBe(20);
      expect(basic.f.site_widget).toBe(true);
      const team = (await q<{ key: string; n: number }>("select key, (limits ->> 'max_booking_team_pages')::int as n from public.plans where key <> 'free' order by position")).rows;
      expect(team).toEqual([
        { key: "personal", n: 0 },
        { key: "basic", n: 0 },
        { key: "pro", n: 10 },
        { key: "business", n: 50 },
      ]);
      const free = (await q<{ l: Record<string, unknown> }>("select limits as l from public.plans where key = 'free'")).rows[0];
      expect(free.l.max_qr_codes).toBe(7);
      await q("rollback to savepoint s");
    });
  });

  it("the seed never touches subscriptions: a trial business stays on pro, trialing", async () => {
    const customer = await createUser("pricing-trial");
    const trial = await createOrg(customer.id);
    const sql = migration("_plan_pricing.sql");
    await asAdmin(async (q) => {
      const read = async () =>
        (await q("select xmin::text as x, plan_key, status, trial_ends_at, feature_overrides, limit_overrides from public.subscriptions where organization_id = $1", [trial]))
          .rows[0];
      const before = await read();
      expect(before).toMatchObject({ plan_key: "pro", status: "trialing" });
      await q("savepoint s");
      // as if the plans still had the old values: the seed rewrites the plans only
      await q("update public.plans set price_monthly_agorot = 1, features = features || '{\"sso\": true}' where key = 'pro'");
      await q(sql);
      expect(await read()).toEqual(before);
      expect((await q<{ p: number; sso: boolean }>("select price_monthly_agorot as p, (features ->> 'sso')::boolean as sso from public.plans where key = 'pro'")).rows[0]).toEqual({ p: 13900, sso: false });
      await q("rollback to savepoint s");
    });
  });
});
