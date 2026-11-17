import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { asAdmin, closePool, type Query } from "./helpers";

afterAll(closePool);

// WEB-02 answer (402) ב: a plan chosen on the price list whose price is zero (both prices 0 in public.plans, judged at
// creation, never from the metadata) starts ACTIVE with no trial: organizations.status 'active', subscription 'active',
// no trial_ends_at. Every other case keeps 021311's trial. Each case runs in one transaction that is rolled back, so the
// plans it changes (the free plan made available, a price set to 0) never reach another test.

class Rollback {
  constructor(readonly value: unknown) {}
}

type Made = {
  org_status: string;
  plan_key: string;
  sub_status: string;
  trial_days: number | null;
  seats: number | null;
  origin_plan: string | null;
  candidate_later: boolean;
  built_with: boolean;
  usage_status: string | null;
};

/** Arrange plans, make a user with the given metadata, create `count` businesses as that user, read what was made. */
async function signUp(arrange: (q: Query) => Promise<void>, meta: Record<string, unknown>, count = 1): Promise<Made[]> {
  try {
    await asAdmin(async (q) => {
      await arrange(q);
      const user = (await q<{ id: string }>(
        "insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id",
        [`web02b-${randomUUID().slice(0, 8)}@example.test`, JSON.stringify({ full_name: "web02b", ...meta })],
      )).rows[0].id;
      const orgs: string[] = [];
      for (let i = 0; i < count; i += 1) {
        await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated" })]);
        await q("set local role authenticated");
        orgs.push((await q<{ id: string }>("select public.create_organization($1) as id", [`עסק ${i}`])).rows[0].id);
        // the owner's own view of the plan screen
        const usage = (await q<{ u: { status?: string } | null }>("select public.org_plan_usage($1) as u", [orgs[i]])).rows[0].u;
        await q("reset role");
        await q("select set_config('request.jwt.claims', '', true)");
        await q("select set_config('web02b.usage_' || $1, $2, true)", [String(i), usage?.status ?? ""]);
      }
      const made: Made[] = [];
      for (let i = 0; i < orgs.length; i += 1) {
        const row = (await q<Made>(
          `select o.status::text as org_status, s.plan_key, s.status::text as sub_status,
                  round(extract(epoch from s.trial_ends_at - now()) / 86400)::int as trial_days, s.seats,
                  (select so.plan_key from app.org_signup_origins so where so.organization_id = o.id) as origin_plan,
                  exists (select 1 from app.trial_end_candidates(now() + interval '60 days') c where c = o.id) as candidate_later,
                  app.show_built_with(o.id) as built_with,
                  nullif(current_setting('web02b.usage_' || $2), '') as usage_status
             from public.organizations o join public.subscriptions s on s.organization_id = o.id
            where o.id = $1`,
          [orgs[i], String(i)],
        )).rows[0];
        made.push(row);
      }
      throw new Rollback(made);
    });
  } catch (error) {
    if (error instanceof Rollback) return error.value as Made[];
    throw error;
  }
  throw new Error("unreachable");
}

const makeFreeAvailable = async (q: Query) => {
  await q("update public.plans set availability = 'available' where key = 'free'");
};

describe("a zero-price plan chosen at sign-up starts active (WEB-02, (402) ב)", () => {
  it("the free plan, when available and chosen, makes an active business with no trial", async () => {
    const prices = await asAdmin(async (q) =>
      (await q<{ m: number; a: number }>("select price_monthly_agorot as m, price_annual_agorot as a from public.plans where key = 'free'")).rows[0],
    );
    expect(prices).toEqual({ m: 0, a: 0 });
    const [made] = await signUp(makeFreeAvailable, { signup_plan: "free", signup_source: "direct" });
    expect(made).toMatchObject({
      org_status: "active",
      plan_key: "free",
      sub_status: "active",
      trial_days: null,
      seats: null,
      origin_plan: "free",
      // BIL-08 never covers it, however late
      candidate_later: false,
      // the free plan does not remove the built-with line
      built_with: true,
      usage_status: "active",
    });
  });

  it("a plan with only one price at zero keeps the 14-day trial", async () => {
    const plan = await asAdmin(async (q) =>
      (await q<{ key: string }>("select key from public.plans where availability = 'available' and price_monthly_agorot > 0 and key <> 'pro' order by position limit 1")).rows[0].key,
    );
    for (const column of ["price_monthly_agorot", "price_annual_agorot"]) {
      const [made] = await signUp(async (q) => void (await q(`update public.plans set ${column} = 0 where key = $1`, [plan])), { signup_plan: plan });
      expect(made).toMatchObject({ org_status: "trial", plan_key: plan, sub_status: "trialing", trial_days: 14 });
    }
    // both at zero: active
    const [both] = await signUp(
      async (q) => void (await q("update public.plans set price_monthly_agorot = 0, price_annual_agorot = 0 where key = $1", [plan])),
      { signup_plan: plan },
    );
    expect(both).toMatchObject({ org_status: "active", plan_key: plan, sub_status: "active", trial_days: null });
  });

  it("a non-zero plan, no choice, a hidden free plan: today's trial, whatever the metadata claims", async () => {
    const available = await asAdmin(async (q) =>
      (await q<{ key: string }>("select key from public.plans where availability = 'available' and price_monthly_agorot > 0 and key <> 'pro' order by position limit 1")).rows[0].key,
    );
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, "pro"],
      [{ signup_plan: available, signup_price: 0, signup_status: "active" }, available],
      // the free plan is hidden in the build: ignored, pro trial
      [{ signup_plan: "free" }, "pro"],
    ];
    for (const [meta, plan] of cases) {
      const [made] = await signUp(async () => undefined, meta);
      expect(made).toMatchObject({ org_status: "trial", plan_key: plan, sub_status: "trialing", trial_days: 14, candidate_later: true });
    }
  });

  it("only the first own business: a second one is today's pro trial", async () => {
    const [first, second] = await signUp(makeFreeAvailable, { signup_plan: "free" }, 2);
    expect(first).toMatchObject({ org_status: "active", sub_status: "active" });
    expect(second).toMatchObject({ org_status: "trial", plan_key: "pro", sub_status: "trialing", trial_days: 14 });
  });
});
