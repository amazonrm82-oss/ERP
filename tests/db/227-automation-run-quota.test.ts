import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client } from "pg";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, TEST_DB_URL, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * AUT-07 (owner's answer of 18 October 2026): a business's automation runs of the month against the plan's
 * max_automation_runs_per_month (an override counts). Only a run that executed a step counts; a manual run and a skipped run
 * do not. The active owners hear once at 80% and once at 100%; at 110% a run is skipped with a reason in the run log.
 * The count and the check are one decision under the counter row's lock.
 */
describe("monthly automation runs against the plan (AUT-07)", () => {
  let owner: U, admin: U;
  let org: string;
  let rule: string;
  let lead: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const execute = (q: Query, key = `event:aut07-${++n}`) =>
    one<{ s: string | null }>(q, "select app.execute_automation(a, $2, $3) as s from public.automations a where a.id = $1", [rule, lead, key]).then((r) => r.s);
  const runIt = (key?: string) => asAdmin((q) => execute(q, key));
  const counted = () =>
    asAdmin(async (q) => (await one<{ n: number }>(q, "select app.automation_runs_this_month($1) as n", [org])).n);
  const quotaNotices = () =>
    asAdmin(async (q) =>
      (
        await q<{ user_id: string; title: string; body: string }>(
          "select user_id, title, body from public.notifications where organization_id = $1 and type = 'system' and title like 'האוטומציות הגיעו%' order by created_at",
          [org],
        )
      ).rows,
    );
  const setLimit = (limit: number | null) =>
    asAdmin((q) => q("update public.subscriptions set limit_overrides = $2 where organization_id = $1", [org, JSON.stringify({ max_automation_runs_per_month: limit })]));

  beforeAll(async () => {
    owner = await createUser("aq-owner");
    org = await createOrg(owner.id, "עסק האוטומציות");
    admin = await addMember(org, owner.id, "admin", "aq-admin");
    lead = await insertLead(owner.id, org, { full_name: "ליד לאוטומציה" });
    rule = await asUser(owner.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.automations (organization_id, name, entity_type, trigger_type, actions, is_active) values ($1, 'כלל', 'lead', 'created', $2, false) returning id",
          [org, JSON.stringify([{ type: "notify", to: "owner", title: "הרצה" }])],
        )
      ).id,
    );
    await setLimit(10);
  });
  // the rule is switched off, so the shared outbox job (other test files) never runs it; these tests call the engine directly

  it("counts executed runs, tells the owners once at 80% and once at 100%, and stops at 110% with a reason", async () => {
    expect(await counted()).toBe(0);
    for (let i = 1; i <= 7; i += 1) expect(await runIt()).not.toBeNull();
    expect(await counted()).toBe(7);
    expect(await quotaNotices()).toEqual([]);
    await runIt(); // 8 = 80%
    let notices = await quotaNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ user_id: owner.id, title: "האוטומציות הגיעו ל-80% ממכסת ההרצות החודשית" });
    expect(notices[0].body).toContain("בוצעו 8 מתוך 10 הרצות החודש");
    await runIt();
    await runIt(); // 10 = 100%
    notices = await quotaNotices();
    expect(notices.map((x) => x.title)).toEqual(["האוטומציות הגיעו ל-80% ממכסת ההרצות החודשית", "האוטומציות הגיעו למכסת ההרצות החודשית"]);
    // only the active owners, never the admin
    expect(notices.every((x) => x.user_id === owner.id)).toBe(true);
    await runIt(); // 11 = 110%, the last one that runs
    expect(await counted()).toBe(11);

    const key = `event:aut07-stopped-${++n}`;
    expect(await runIt(key)).toBe("skipped");
    expect(await counted()).toBe(11);
    const run = await asAdmin((q) =>
      one<{ status: string; steps: Array<{ status: string; error: string }> }>(q, "select status, steps from public.automation_runs where automation_id = $1 and run_key = $2", [rule, key]),
    );
    expect(run).toEqual({ status: "skipped", steps: [{ action: null, status: "error", error: "the monthly automation runs of the plan are used up" }] });
    // no more notices at 110%
    expect(await quotaNotices()).toHaveLength(2);
  });

  it("a manual run is not counted, and runs; a skipped run and a run whose conditions do not match are not counted", async () => {
    const before = await counted();
    const manual = await asUser(owner.id, async (q) => (await one<{ r: unknown }>(q, "select public.run_automation_now($1, $2) as r", [rule, lead])).r);
    expect(manual).toBeTruthy();
    expect(await counted()).toBe(before);
    // a rule whose conditions do not match runs nothing and counts nothing
    await asAdmin((q) => q("update public.automations set conditions = $2 where id = $1", [rule, JSON.stringify([{ field: "owner_id", op: "empty" }])]));
    try {
      await setLimit(null);
      expect(await runIt()).toBeNull();
      expect(await counted()).toBe(before);
    } finally {
      await asAdmin((q) => q("update public.automations set conditions = '[]'::jsonb where id = $1", [rule]));
    }
  });

  it("an override raises the limit and the plan screen lists the month's runs", async () => {
    await setLimit(100);
    expect(await runIt()).not.toBe("skipped");
    const usage = await asUser(admin.id, async (q) =>
      (await one<{ u: { usage: Array<{ key: string; limit: number | null; used: number }> } }>(q, "select public.org_plan_usage($1) as u", [org])).u.usage,
    );
    expect(usage.find((row) => row.key === "max_automation_runs_per_month")).toEqual({ key: "max_automation_runs_per_month", limit: 100, used: await counted() });
  });

  it("the month is the business's own month", async () => {
    await asAdmin((q) => q("update public.organizations set timezone = 'Pacific/Kiritimati' where id = $1", [org]));
    try {
      const months = await asAdmin((q) =>
        one<{ mine: string; expected: string }>(
          q,
          "select app.automation_run_month($1)::text as mine, date_trunc('month', now() at time zone 'Pacific/Kiritimati')::date::text as expected",
          [org],
        ),
      );
      expect(months.mine).toBe(months.expected);
    } finally {
      await asAdmin((q) => q("update public.organizations set timezone = 'Asia/Jerusalem' where id = $1", [org]));
    }
  });

  it("two jobs at the edge: the second waits for the first and is skipped, never both run", async () => {
    await setLimit(10);
    // the counter at one below the stop (110% of 10 = 11)
    await asAdmin((q) =>
      q("update app.automation_run_months set runs = 10, warned_80_at = now(), warned_100_at = now() where organization_id = $1 and month = app.automation_run_month($1)", [org]),
    );
    const a = new Client({ connectionString: TEST_DB_URL });
    const b = new Client({ connectionString: TEST_DB_URL });
    await a.connect();
    await b.connect();
    try {
      await a.query("begin");
      const first = (await a.query<{ s: string }>("select app.execute_automation(x, $2, $3) as s from public.automations x where x.id = $1", [rule, lead, `event:aut07-a-${++n}`])).rows[0].s;
      expect(first).not.toBe("skipped");
      const second = b.query<{ s: string }>("select app.execute_automation(x, $2, $3) as s from public.automations x where x.id = $1", [rule, lead, `event:aut07-b-${++n}`]);
      // b waits on the counter row while a holds it
      await new Promise((resolve) => setTimeout(resolve, 300));
      const waiting = await asAdmin((q) => count(q, "select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like '%execute_automation%'"));
      expect(waiting).toBeGreaterThanOrEqual(1);
      await a.query("commit");
      expect((await second).rows[0].s).toBe("skipped");
      expect(await counted()).toBe(11);
    } finally {
      await a.end();
      await b.end();
    }
  });
  it("a plan without a limit neither locks nor counts: two jobs run side by side", async () => {
    await setLimit(null);
    const before = await counted();
    const a = new Client({ connectionString: TEST_DB_URL });
    const b = new Client({ connectionString: TEST_DB_URL });
    await a.connect();
    await b.connect();
    try {
      await a.query("begin");
      const run = (c: Client) =>
        c.query<{ s: string }>("select app.execute_automation(x, $2, $3) as s from public.automations x where x.id = $1", [rule, lead, `event:aut07-free-${++n}`]);
      expect((await run(a)).rows[0].s).toBe("success");
      // b does not wait for a's open transaction
      const second = await Promise.race([run(b).then((r) => r.rows[0].s), new Promise<string>((resolve) => setTimeout(() => resolve("waited"), 3000))]);
      expect(second).toBe("success");
      await a.query("commit");
    } finally {
      await a.end();
      await b.end();
    }
    expect(await counted()).toBe(before);
  });
});
