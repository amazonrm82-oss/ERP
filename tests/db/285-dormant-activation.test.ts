import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];

/**
 * RET-01, owner's answer (64) ג (2 November 2026): a customer_dormant rule runs only for customers who become dormant from the
 * day it was switched on (automations.dormant_from, server only); the customers already dormant then are run only when a
 * manager of automations says yes (public.run_dormant_backfill: once per activation, counted by AUT-07, one audit entry with
 * the count). public.dormant_customer_count gives the question its number.
 */
describe("switching a dormant-customer rule on (RET-01, answer (64) ג)", () => {
  let owner: U, member: U, granted: U, outsider: U;
  let org: string, wonStage: string, pipelineId: string;
  let early: string, late: string, active: string;

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  const today = () => asAdmin(async (q) => (await one<{ d: string }>(q, "select app.org_zone_today($1)::text as d", [org])).d);
  const startOf = (auto: string) =>
    asAdmin(async (q) => (await one<{ d: string | null }>(q, "select dormant_from::text as d from public.automations where id = $1", [auto])).d);
  const rule = (active = true, entity: "contact" | "company" = "contact", trigger = "customer_dormant") =>
    asUser(owner.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.automations (organization_id, name, entity_type, trigger_type, actions, is_active) values ($1, 'רדום', $2, $3, $4, $5) returning id",
          [org, entity, trigger, JSON.stringify([{ type: "create_task", title: "לחזור ללקוח", due_in_days: 1 }]), active],
        )
      ).id,
    );
  const off = (auto: string) => asUser(owner.id, (q) => q("update public.automations set is_active = false where id = $1", [auto]));
  const runScan = () =>
    asAdmin(async (q) => {
      await q("select set_config('app.date_trigger_hour', '0', true)");
      return (await one<{ n: number }>(q, "select app.run_dormant_automations() as n")).n;
    });
  const ranFor = (auto: string) =>
    asAdmin(async (q) => (await q<{ entity_id: string }>("select entity_id from public.automation_runs where automation_id = $1", [auto])).rows.map((r) => r.entity_id));
  const backfill = (u: U, auto: string, caps: { runs?: number; rows?: number } = {}) =>
    asUser(u.id, async (q) => {
      if (caps.runs) await q("select set_config('app.dormant_backfill_runs_cap', $1, true)", [String(caps.runs)]);
      if (caps.rows) await q("select set_config('app.dormant_backfill_rows_cap', $1, true)", [String(caps.rows)]);
      return (await one<{ r: Record<string, unknown> }>(q, "select public.run_dormant_backfill($1, $2) as r", [org, auto])).r;
    });
  const monthsOf = (auto: string) =>
    asAdmin(async (q) => (await one<{ m: number | null }>(q, "select dormant_from_months as m from public.automations where id = $1", [auto])).m);
  const countOf = (u: U, kind = "contact") =>
    asUser(u.id, async (q) => (await one<{ n: number }>(q, "select public.dormant_customer_count($1, $2) as n", [org, kind])).n);
  const runsThisMonth = () => asAdmin(async (q) => (await one<{ n: number }>(q, "select app.automation_runs_this_month($1) as n", [org])).n);

  beforeAll(async () => {
    owner = await createUser("ret64-owner");
    org = await createOrg(owner.id, "עסק הרדומים");
    member = await addMember(org, owner.id, "member", "ret64-member");
    granted = await addMember(org, owner.id, "member", "ret64-granted");
    outsider = await createUser("ret64-outsider");
    await createOrg(outsider.id, "עסק אחר");
    await asAdmin(async (q) => {
      await q("update public.subscriptions set feature_overrides = $2, limit_overrides = $3 where organization_id = $1", [
        org,
        JSON.stringify({ granular_permissions: true }),
        JSON.stringify({ max_automation_runs_per_month: 1000 }),
      ]);
      await q("insert into public.member_permissions (organization_id, user_id, permissions) values ($1, $2, '{manage_automations}')", [org, granted.id]);
    });
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    wonStage = pipe.stages.find((s) => s.kind === "won")!.id;
    const contact = (name: string) =>
      asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, $2) returning id", [org, name])).id);
    const won = (c: string, days: number) =>
      asUser(owner.id, (q) =>
        q(
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, amount_agorot, owner_id, closed_at) values ($1, 'עסקה', $2, $3, $4, 100, $5, $6)",
          [org, pipelineId, wonStage, c, owner.id, daysAgo(days)],
        ),
      );
    // dormant about 218 days ago, about 68 days ago, and an active customer
    early = await contact("רדום מזמן");
    late = await contact("רדום לאחרונה");
    active = await contact("פעיל");
    await won(early, 400);
    await won(late, 250);
    await won(active, 20);
  });

  it("the start point is set on an active insert and on switching on, and only by the server", async () => {
    const t = await today();
    const a = await rule(true);
    const b = await rule(false);
    const other = await rule(true, "contact", "created");
    try {
      expect(await startOf(a)).toBe(t);
      expect(await monthsOf(a)).toBe(6);
      expect(await startOf(b)).toBeNull();
      expect(await monthsOf(b)).toBeNull();
      expect(await startOf(other)).toBeNull();
      // switching on stamps today; switching off keeps it; switching on again stamps today again
      await asAdmin((q) => q("update public.automations set dormant_from = '2001-01-01' where id = $1", [a]));
      await off(a);
      expect(await startOf(a)).toBe("2001-01-01");
      await asUser(owner.id, (q) => q("update public.automations set is_active = true where id = $1", [a]));
      expect(await startOf(a)).toBe(t);
      await asUser(owner.id, (q) => q("update public.automations set is_active = true where id = $1", [b]));
      expect(await startOf(b)).toBe(t);
      // an active rule changed into a dormant rule starts today
      await asUser(owner.id, (q) => q("update public.automations set trigger_type = 'customer_dormant' where id = $1", [other]));
      expect(await startOf(other)).toBe(t);
      // a person never writes it
      expect((await pgError(asUser(owner.id, (q) => q("update public.automations set dormant_from = '2001-01-01' where id = $1", [a])))).code).toBe("42501");
      expect((await pgError(asUser(owner.id, (q) => q("update public.automations set dormant_from_months = 1 where id = $1", [a])))).code).toBe("42501");
      expect(
        (await pgError(
          asUser(owner.id, (q) =>
            q("insert into public.automations (organization_id, name, entity_type, trigger_type, actions, dormant_from) values ($1, 'x', 'contact', 'customer_dormant', '[]', '2001-01-01')", [org]),
          ),
        )).code,
      ).toBe("42501");
    } finally {
      for (const id of [a, b, other]) await off(id);
    }
  });

  it("the scan runs only for customers who became dormant on or after the start point", async () => {
    const auto = await rule(true);
    try {
      // switched on today: both are dormant from before, nobody runs
      await runScan();
      expect(await ranFor(auto)).toEqual([]);
      // a start point 100 days back: the late one became dormant after it, the early one before
      await asAdmin((q) => q("update public.automations set dormant_from = app.org_zone_today(organization_id) - 100 where id = $1", [auto]));
      await runScan();
      expect(await ranFor(auto)).toEqual([late]);
    } finally {
      await off(auto);
    }
  });

  it("the count: managers of automations only, the customers dormant before today", async () => {
    expect(await countOf(owner)).toBe(2);
    expect(await countOf(granted)).toBe(2);
    expect(await countOf(owner, "company")).toBe(0);
    for (const u of [member, outsider]) expect((await pgError(countOf(u))).code).toBe("42501");
    expect((await pgError(countOf(owner, "lead"))).hint).toBe("customer_status:kind");
  });

  it("the backfill runs once per activation, counted by AUT-07 and logged with the count", async () => {
    const auto = await rule(true);
    try {
      // rights first
      for (const u of [member, outsider]) expect((await pgError(backfill(u, auto))).code).toBe("42501");
      const before = await runsThisMonth();
      const tasks = () => asAdmin((q) => count(q, "select 1 from public.tasks where organization_id = $1 and title = 'לחזור ללקוח' and contact_id = any($2)", [org, [early, late]]));
      const tasksBefore = await tasks();
      expect(await backfill(granted, auto)).toEqual({ ok: true, ran: 2, skipped: 0, more: false, quota: false });
      expect((await ranFor(auto)).sort()).toEqual([early, late].sort());
      expect(await runsThisMonth()).toBe(before + 2);
      expect(await tasks()).toBe(tasksBefore + 2);
      const audit = await asAdmin((q) =>
        one<{ actor_id: string; changes: Record<string, unknown> }>(
          q, "select actor_id, changes from public.audit_log where organization_id = $1 and action = 'dormant_backfill' and entity_id = $2", [org, auto]),
      );
      expect(audit.actor_id).toBe(granted.id);
      expect(audit.changes).toMatchObject({ count: 2, skipped: 0, more: false, quota: false });
      // a second call is refused, and runs nothing
      expect(await backfill(owner, auto)).toEqual({ ok: false, reason: "done" });
      expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and action = 'dormant_backfill' and entity_id = $2", [org, auto]))).toBe(1);
      // the scan never runs them again
      await runScan();
      expect(await ranFor(auto)).toHaveLength(2);
      // switching off and on again the same day is the same activation (the start point is a day)
      await off(auto);
      await asUser(owner.id, (q) => q("update public.automations set is_active = true where id = $1", [auto]));
      expect(await backfill(owner, auto)).toEqual({ ok: false, reason: "done" });
      // an activation on another day opens a new backfill; the run keys still keep each customer to one run
      await asAdmin((q) => q("update public.automations set dormant_from = dormant_from + 1 where id = $1", [auto]));
      expect(await backfill(owner, auto)).toEqual({ ok: true, ran: 0, skipped: 0, more: false, quota: false });
      expect(await ranFor(auto)).toHaveLength(2);
    } finally {
      await off(auto);
    }
  });

  it("refuses an inactive rule, another trigger, another business's rule and a business that cannot write", async () => {
    const auto = await rule(false);
    const other = await rule(false, "contact", "created");
    try {
      expect(await backfill(owner, auto)).toEqual({ ok: false, reason: "inactive" });
      expect((await pgError(backfill(owner, other))).hint).toBe("dormant_backfill:rule");
      const foreign = await asUser(outsider.id, async (q) => {
        const o = (await one<{ id: string }>(q, "select organization_id as id from public.memberships where user_id = $1", [outsider.id])).id;
        return (await one<{ id: string }>(q,
          "insert into public.automations (organization_id, name, entity_type, trigger_type, actions) values ($1, 'x', 'contact', 'customer_dormant', $2) returning id", [o, JSON.stringify([{ type: "create_task", title: "x", due_in_days: 1 }])])).id;
      });
      expect((await pgError(backfill(owner, foreign))).code).toBe("42501");
      await asUser(owner.id, (q) => q("update public.automations set is_active = true where id = $1", [auto]));
      await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
      try {
        expect((await pgError(backfill(owner, auto))).code).toBe("42501");
      } finally {
        await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
      }
    } finally {
      await off(auto);
      await off(other);
    }
  });

  it("a run skipped by the monthly quota stops the backfill, which may be made again", async () => {
    const auto = await rule(true);
    try {
      // the month is used up (110% of the limit)
      const used = await runsThisMonth();
      await asAdmin((q) => q("update public.subscriptions set limit_overrides = $2 where organization_id = $1", [org, JSON.stringify({ max_automation_runs_per_month: Math.max(1, Math.floor(used / 1.1)) })]));
      const r = await backfill(owner, auto);
      expect(r).toMatchObject({ ok: true, ran: 0, skipped: 1, quota: true });
      // not done: a later call is allowed (the skipped customer keeps its skipped run)
      await asAdmin((q) => q("update public.subscriptions set limit_overrides = $2 where organization_id = $1", [org, JSON.stringify({ max_automation_runs_per_month: 1000 })]));
      expect(await backfill(owner, auto)).toEqual({ ok: true, ran: 1, skipped: 0, more: false, quota: false });
      expect(await backfill(owner, auto)).toEqual({ ok: false, reason: "done" });
    } finally {
      await off(auto);
    }
  });

  it("one call is short: a runs cap and a rows cap answer `more`, the next call goes on from its cursor", async () => {
    // runs cap: one run a call
    const a = await rule(true);
    try {
      expect(await backfill(owner, a, { runs: 1 })).toEqual({ ok: true, ran: 1, skipped: 0, more: true, quota: false });
      expect(await ranFor(a)).toHaveLength(1);
      const second = await backfill(owner, a, { runs: 1 });
      expect(second).toMatchObject({ ok: true, ran: 1 });
      expect((await ranFor(a)).sort()).toEqual([early, late].sort());
      if (second.more) expect(await backfill(owner, a, { runs: 1 })).toEqual({ ok: true, ran: 0, skipped: 0, more: false, quota: false });
      expect(await backfill(owner, a, { runs: 1 })).toEqual({ ok: false, reason: "done" });
    } finally {
      await off(a);
    }
    // rows cap: every row reached counts, also one the call does not run (the late one became dormant after the start point)
    const b = await rule(true);
    try {
      await asAdmin((q) => q("update public.automations set dormant_from = app.org_zone_today(organization_id) - 100 where id = $1", [b]));
      const answers = [];
      for (let i = 0; i < 4; i++) {
        const r = await backfill(owner, b, { rows: 1 });
        answers.push(r);
        if (r.ok === false) break;
      }
      // two rows, one a call: more, more, then the end of the list, then done
      expect(answers.map((r) => r.more ?? r.reason)).toEqual([true, true, false, "done"]);
      expect(answers.reduce((n, r) => n + (typeof r.ran === "number" ? r.ran : 0), 0)).toBe(1);
      expect(await ranFor(b)).toEqual([early]);
      const audits = await asAdmin((q) =>
        q<{ e: number }>("select (changes ->> 'examined')::int as e from public.audit_log where organization_id = $1 and action = 'dormant_backfill' and entity_id = $2 order by created_at, id", [org, b]),
      );
      expect(audits.rows.map((r) => r.e)).toEqual([1, 1, 0]);
    } finally {
      await off(b);
    }
  });

  it("lowering the dormant months later never hides a newly dormant customer from the scan", async () => {
    const auto = await rule(true);
    const c = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'ארבעה חודשים') returning id", [org])).id);
    await asUser(owner.id, (q) =>
      q(
        "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, amount_agorot, owner_id, closed_at) values ($1, 'עסקה', $2, $3, $4, 100, $5, $6)",
        [org, pipelineId, wonStage, c, owner.id, daysAgo(120)],
      ),
    );
    try {
      expect(await backfill(owner, auto)).toMatchObject({ ok: true, ran: 2, more: false });
      expect(await backfill(owner, auto)).toEqual({ ok: false, reason: "done" });
      await asUser(owner.id, (q) => q("insert into public.customer_status_settings (organization_id, dormant_months, former_months) values ($1, 3, 18) on conflict do nothing", [org]));
      await asUser(owner.id, (q) => q("update public.customer_status_settings set dormant_months = 3 where organization_id = $1", [org]));
      await runScan();
      expect((await ranFor(auto)).filter((id) => id === c)).toEqual([c]);
      // a fresh rule switched on after the change counts by the months of its own day: the 120-day customer is already dormant
      const fresh = await rule(true);
      try {
        expect(await monthsOf(fresh)).toBe(3);
        await runScan();
        expect(await ranFor(fresh)).toEqual([]);
      } finally {
        await off(fresh);
      }
    } finally {
      await asUser(owner.id, (q) => q("update public.customer_status_settings set dormant_months = 6 where organization_id = $1", [org]));
      await off(auto);
    }
  });
});
