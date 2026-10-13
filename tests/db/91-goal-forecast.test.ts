import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Line = { deals: number; amount: number; weighted: number };
type Forecast = {
  today: string;
  goal_scope: string;
  complete: boolean;
  months: Array<Line & { month: string; won_amount: number; goal: number | null }>;
  overdue: Line;
  undated: Line;
  by_owner: Array<Line & { owner_id: string | null; month_weighted: number; overdue_deals: number; overdue_weighted: number }>;
  by_stage: Array<Line & { stage_id: string; name: string; pipeline_name: string; month_weighted: number; overdue_deals: number; overdue_weighted: number }>;
  overdue_deals: Array<{ id: string; name: string; owner_id: string | null; pipeline_id: string; expected_close_date: string; weighted: number }>;
};

// GOL-04: the forecast screen. Weighted open deals by expected close month against the month's
// won_amount goal; overdue deals in a line of their own; by owner and by stage. Security invoker.
describe("forecast against the goal (GOL-04)", () => {
  let owner: U, m1: U, m2: U, outsider: U;
  let org: string;
  let today: string;
  let thisMonth: string;
  let nextMonth: string;
  let stageOpen: { id: string; probability: number };
  const deals: Record<string, string> = {};

  const forecast = (userId: string, args: unknown[] = []) =>
    asUser(userId, async (q) => {
      const params = [org, ...args];
      return (await q<{ r: Forecast }>(`select public.report_goal_forecast(${params.map((_, i) => `$${i + 1}`).join(", ")}) as r`, params)).rows[0].r;
    });

  beforeAll(async () => {
    owner = await createUser("owner");
    outsider = await createUser("outsider");
    org = await createOrg(owner.id);
    await createOrg(outsider.id, "עסק אחר");
    m1 = await addMember(org, owner.id, "member", "m1");
    m2 = await addMember(org, owner.id, "member", "m2");

    const dates = await asAdmin(async (q) =>
      (
        await q<{ today: string; this_month: string; next_month: string; last_week: string; in_month: string; later: string }>(
          `select to_char(t, 'YYYY-MM-DD') as today,
                  to_char(date_trunc('month', t), 'YYYY-MM-DD') as this_month,
                  to_char(date_trunc('month', t) + interval '1 month', 'YYYY-MM-DD') as next_month,
                  to_char(t - 7, 'YYYY-MM-DD') as last_week,
                  to_char(greatest(t, (date_trunc('month', t) + interval '1 month' - interval '1 day')::date), 'YYYY-MM-DD') as in_month,
                  to_char(date_trunc('month', t) + interval '1 month' + interval '9 days', 'YYYY-MM-DD') as later
             from (select (now() at time zone 'Asia/Jerusalem')::date as t) x`,
        )
      ).rows[0],
    );
    today = dates.today;
    thisMonth = dates.this_month;
    nextMonth = dates.next_month;

    await asAdmin(async (q) => {
      const p = (await q<{ id: string }>("select id from public.pipelines where organization_id = $1 and is_default", [org])).rows[0].id;
      stageOpen = (await q<{ id: string; probability: number }>("select id, probability from public.stages where pipeline_id = $1 and kind = 'open' order by position limit 1", [p])).rows[0];
      const won = (await q<{ id: string }>("select id from public.stages where pipeline_id = $1 and kind = 'won' limit 1", [p])).rows[0].id;
      // the first open stage has a probability; set one we can count with
      await q("update public.stages set probability = 50 where id = $1", [stageOpen.id]);
      const add = async (key: string, owner: string | null, amount: number, expected: string | null, stage = stageOpen.id) => {
        deals[key] = (
          await q<{ id: string }>(
            `insert into public.deals (organization_id, name, owner_id, amount_agorot, pipeline_id, stage_id, expected_close_date)
             values ($1, $2, $3, $4, $5, $6, $7) returning id`,
            [org, key, owner, amount, p, stage, expected],
          )
        ).rows[0].id;
      };
      await add("m1 this month", m1.id, 100000, dates.in_month);
      await add("m1 overdue", m1.id, 40000, dates.last_week);
      await add("m2 next month", m2.id, 60000, dates.later);
      await add("m2 undated", m2.id, 20000, null);
      await add("m1 won", m1.id, 30000, null, won);
    });

    await asUser(owner.id, async (q) => {
      const goal = (scope: string, user: string | null, start: string, target: number) =>
        q(
          "insert into public.goals (organization_id, scope, user_id, period, period_start, metric, target) values ($1, $2, $3, 'month', $4, 'won_amount', $5)",
          [org, scope, user, start, target],
        );
      await goal("org", null, thisMonth, 200000);
      await goal("org", null, nextMonth, 300000);
      await goal("user", m1.id, thisMonth, 90000);
      // a goal three months ahead with no deals still gets its month
      await goal("org", null, await asAdmin(async (a) => (await a<{ d: string }>("select to_char($1::date + interval '3 months', 'YYYY-MM-DD') as d", [thisMonth])).rows[0].d), 100000);
    });
  });

  it("months weighted against the business's goal; overdue and undated deals are lines of their own", async () => {
    const f = await forecast(owner.id);
    expect(f.today).toBe(today);
    expect(f.goal_scope).toBe("org");
    expect(f.months.map((m) => m.month)).toHaveLength(3);
    const [cur, next, third] = f.months;
    // the overdue deal is not inside this month
    expect(cur).toMatchObject({ month: thisMonth, deals: 1, amount: 100000, weighted: 50000, won_amount: 30000, goal: 200000 });
    expect(next).toMatchObject({ month: nextMonth, deals: 1, weighted: 30000, won_amount: 0, goal: 300000 });
    expect(third).toMatchObject({ deals: 0, weighted: 0, goal: 100000 });
    expect(f.overdue).toEqual({ deals: 1, amount: 40000, weighted: 20000 });
    expect(f.undated).toEqual({ deals: 1, amount: 20000, weighted: 10000 });
    expect(f.overdue_deals.map((d) => d.id)).toEqual([deals["m1 overdue"]]);
  });

  it("by owner and by stage, with this month's and the overdue part", async () => {
    const f = await forecast(owner.id);
    const m1Row = f.by_owner.find((r) => r.owner_id === m1.id);
    expect(m1Row).toMatchObject({ deals: 2, weighted: 70000, month_weighted: 50000, overdue_deals: 1, overdue_weighted: 20000 });
    expect(f.by_owner.find((r) => r.owner_id === m2.id)).toMatchObject({ deals: 2, weighted: 40000, month_weighted: 0, overdue_deals: 0 });
    expect(f.by_stage).toHaveLength(1);
    expect(f.by_stage[0]).toMatchObject({ stage_id: stageOpen.id, deals: 4, weighted: 110000, overdue_deals: 1 });
  });

  it("with an owner, that person's deals against their own goal", async () => {
    const f = await forecast(owner.id, [null, m1.id]);
    expect(f.goal_scope).toBe("user");
    expect(f.months[0]).toMatchObject({ month: thisMonth, weighted: 50000, won_amount: 30000, goal: 90000 });
    expect(f.overdue.deals).toBe(1);
    expect(f.undated.deals).toBe(0);
  });

  it("RLS decides: under 'own' visibility a member sees their deals only, and no goal unless it is their own forecast", async () => {
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const f = await forecast(m2.id);
      expect(f.by_owner.map((r) => r.owner_id)).toEqual([m2.id]);
      expect(f.overdue.deals).toBe(0);
      // the business's goal next to a partial forecast would mislead: not returned
      expect(f.complete).toBe(false);
      expect(f.months.every((m) => m.goal === null)).toBe(true);
      // m1's own forecast is whole, with m1's own goal
      const own = await forecast(m1.id, [null, m1.id]);
      expect(own).toMatchObject({ complete: true, goal_scope: "user" });
      expect(own.months[0]).toMatchObject({ weighted: 50000, goal: 90000 });
      // someone else's: neither whole nor their goal
      const other = await forecast(m2.id, [null, m1.id]);
      expect(other.complete).toBe(false);
      expect(other.months[0].goal).toBeNull();
      expect(other.months[0].deals).toBe(0);
      // owners see everything
      expect((await forecast(owner.id)).complete).toBe(true);
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
    // under 'org' visibility a member's view is whole
    expect(await forecast(m2.id)).toMatchObject({ complete: true });
  });

  it("with a pipeline picked there is no goal: a goal covers every pipeline", async () => {
    const pipeline = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.pipelines where organization_id = $1 and is_default", [org])).rows[0].id);
    const f = await forecast(owner.id, [pipeline]);
    expect(f.months[0]).toMatchObject({ weighted: 50000, goal: null });
    expect(f.overdue_deals[0].pipeline_id).toBe(pipeline);
  });

  it("an overdue deal given a date inside the month enters the month at once", async () => {
    await asUser(m1.id, (q) => q("update public.deals set expected_close_date = $2 where id = $1", [deals["m1 overdue"], today]));
    try {
      const f = await forecast(owner.id);
      expect(f.overdue.deals).toBe(0);
      expect(f.overdue_deals).toEqual([]);
      expect(f.months[0]).toMatchObject({ month: thisMonth, deals: 2, weighted: 70000 });
    } finally {
      await asAdmin((q) =>
        q("update public.deals set expected_close_date = (now() at time zone 'Asia/Jerusalem')::date - 7 where id = $1", [deals["m1 overdue"]]),
      );
    }
  });

  it("weighted values are rounded once per total", async () => {
    const pipeline = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.pipelines where organization_id = $1 and is_default", [org])).rows[0].id);
    const odd = await asAdmin(async (q) => {
      // two deals of 1 agora at 50%: 0.5 + 0.5 = 1, not 1 + 1 (each rounded) = 2
      const ids: string[] = [];
      for (const name of ["odd 1", "odd 2"]) {
        ids.push(
          (
            await q<{ id: string }>(
              "insert into public.deals (organization_id, name, owner_id, amount_agorot, pipeline_id, stage_id, expected_close_date) values ($1, $2, $3, 1, $4, $5, null) returning id",
              [org, name, m2.id, pipeline, stageOpen.id],
            )
          ).rows[0].id,
        );
      }
      return ids;
    });
    try {
      expect((await forecast(owner.id)).undated).toEqual({ deals: 3, amount: 20002, weighted: 10001 });
    } finally {
      await asAdmin((q) => q("delete from public.deals where id = any($1)", [odd]));
    }
  });

  it("outsiders get nothing; anonymous callers may not run it; security invoker", async () => {
    expect(await forecast(outsider.id)).toBeNull();
    expect((await pgError(asAnon((q) => q("select public.report_goal_forecast($1)", [org])))).code).toBe("42501");
    const definer = await asAdmin(async (q) => (await q<{ d: boolean }>("select prosecdef as d from pg_proc where proname = 'report_goal_forecast'")).rows[0].d);
    expect(definer).toBe(false);
  });
});
