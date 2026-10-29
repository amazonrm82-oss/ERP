import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Row = { goal_id: string; scope: string; metric: string; target: number; actual: number };

/**
 * GOL-01, collection ("גבייה"): goals.metric 'collected'. report_goal_progress counts payments recorded or confirmed whose
 * paid_on is in the goal's period (COL-06's rule), by rep (the deal's owner, else the contact's) and team (the deal's, else
 * the contact's, with the teams below), and returns a collection goal only when the caller reads every payment that counts
 * for it (app.goal_payments_counted). Owner's answers of 29 October 2026: plan keys payments, documents and collection
 * (trigger goals_collected, a hint per key); the actual only for those who record payments (app.can_record_payments); a
 * cheque counts once cleared or due.
 */
describe("collection goals (GOL-01)", () => {
  let owner: U, admin: U, manager: U, m1: U, m2: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let north: string, northWest: string;
  let pipelineId: string, stageId: string;
  const goal: Record<string, string> = {};
  const FEATURES = { payments: true, documents: true, collection: true, goals_per_rep: true, granular_permissions: true };
  const SEP = "2026-09-01";

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const progress = (u: U, period = "month", start = SEP, orgId = org) =>
    asUser(u.id, async (q) => (await one<{ r: Row[] }>(q, "select public.report_goal_progress($1, $2, $3::date) as r", [orgId, period, start])).r);
  const collected = async (u: U, period = "month", start = SEP) =>
    Object.fromEntries((await progress(u, period, start)).filter((r) => r.metric === "collected").map((r) => [r.goal_id, r.actual]));
  const setFeatures = (features: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(features)]));
  const addGoal = (u: U, row: Record<string, unknown>) =>
    asUser(u.id, async (q) => {
      const full = { organization_id: org, period: "month", period_start: SEP, metric: "collected", target: 100000, ...row };
      const cols = Object.keys(full);
      return (
        await one<{ id: string }>(
          q,
          `insert into public.goals (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
          Object.values(full),
        )
      ).id;
    });
  const contact = (name: string, ownerId: string | null, teamId: string | null = null) =>
    asAdmin(async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id, team_id) values ($1, $2, $3, $4) returning id", [org, name, ownerId, teamId])).id,
    );
  const deal = (name: string, ownerId: string | null, teamId: string | null, contactId: string | null = null) =>
    asAdmin(async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id, team_id, contact_id) values ($1, $2, $3, $4, $5, $6, $7) returning id",
          [org, name, pipelineId, stageId, ownerId, teamId, contactId],
        )
      ).id,
    );
  const pay = (amount: number, on: string, where: { deal?: string | null; contact?: string | null }) =>
    asUser(owner.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.payments (organization_id, deal_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, $3, $4, $5, 'cash') returning id",
          [org, where.deal ?? null, where.contact ?? null, amount, on],
        )
      ).id,
    );

  beforeAll(async () => {
    owner = await createUser("gc-owner");
    outsider = await createUser("gc-outsider");
    org = await createOrg(owner.id, "עסק יעדי גבייה");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    admin = await addMember(org, owner.id, "admin", "gc-admin");
    manager = await addMember(org, owner.id, "manager", "gc-manager");
    m1 = await addMember(org, owner.id, "member", "gc-m1");
    m2 = await addMember(org, owner.id, "member", "gc-m2");
    viewer = await addMember(org, owner.id, "viewer", "gc-viewer");
    await setFeatures(FEATURES);
    await asAdmin(async (q) => {
      await q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [otherOrg, JSON.stringify(FEATURES)]);
      await q("update public.organizations set record_visibility = 'own' where id = $1", [org]);
    });
    const pipe = await asAdmin((q) =>
      one<{ p: string; s: string }>(
        q,
        "select p.id as p, s.id as s from public.pipelines p join public.stages s on s.pipeline_id = p.id where p.organization_id = $1 and p.is_default and s.kind = 'open' order by s.position limit 1",
        [org],
      ),
    );
    pipelineId = pipe.p;
    stageId = pipe.s;
    [north, northWest] = await asUser(owner.id, async (q) => {
      const a = (await one<{ id: string }>(q, "insert into public.teams (organization_id, name) values ($1, 'צפון') returning id", [org])).id;
      const b = (await one<{ id: string }>(q, "insert into public.teams (organization_id, name, parent_team_id) values ($1, 'צפון-מערב', $2) returning id", [org, a])).id;
      await q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true), ($1, $2, $4, false), ($1, $5, $6, false)", [
        org,
        a,
        manager.id,
        m1.id,
        b,
        m2.id,
      ]);
      return [a, b];
    });

    const c1 = await contact("לקוח של m1", m1.id, north);
    const c2 = await contact("לקוח של m2", m2.id, northWest);
    const d1 = await deal("עסקה של m1", m1.id, north, c2); // the deal's owner wins over the contact's
    const dNoOwner = await deal("עסקה בלי בעלים", null, null, c1);

    // September 2026, m1: 1,000 (deal) + 2,000 (contact, first day) + 4,000 (contact, last day)
    await pay(100000, "2026-09-15", { deal: d1 });
    await pay(200000, "2026-09-01", { contact: c1 });
    await pay(400000, "2026-09-30", { contact: c1 });
    // m2: 8,000 on their contact (team north-west, below north)
    await pay(800000, "2026-09-10", { contact: c2 });
    // outside the month: the day before and the day after
    await pay(1600000, "2026-08-31", { contact: c1 });
    await pay(3200000, "2026-10-01", { contact: c1 });
    // failed, refunded and cancelled never count
    const failed = await pay(50000, "2026-09-11", { contact: c1 });
    const refunded = await pay(60000, "2026-09-12", { contact: c1 });
    const cancelled = await pay(70000, "2026-09-13", { contact: c1 });
    await asUser(owner.id, async (q) => {
      await q("update public.payments set status = 'failed' where id = $1", [failed]);
      await q("update public.payments set status = 'refunded' where id = $1", [refunded]);
      await q("update public.payments set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [cancelled]);
    });
    // confirmed counts like recorded
    await asUser(owner.id, async (q) => q("update public.payments set status = 'confirmed' where organization_id = $1 and paid_on = '2026-09-30'", [org]));

    goal.org = await addGoal(owner, { scope: "org" });
    goal.north = await addGoal(owner, { scope: "team", team_id: north });
    goal.m1 = await addGoal(owner, { scope: "user", user_id: m1.id });
    goal.m2 = await addGoal(owner, { scope: "user", user_id: m2.id });
    goal.orgQuarter = await addGoal(owner, { scope: "org", period: "quarter", period_start: "2026-07-01" });
    goal.orgOctober = await addGoal(owner, { scope: "org", period_start: "2026-10-01" });
    // m1 records payments through the PRM-01 key; m2 does not (owner's answer (16) ב)
    await asUser(owner.id, (q) => q("select public.set_member_permissions($1, $2, '{record_payments}')", [org, m1.id]));

    // a later payment on the deal with no owner: credited to its contact's owner (m1), but m1 cannot read that deal
    goal.dNoOwner = dNoOwner;
    goal.c1 = c1;
  });

  it("counts recorded and confirmed payments by paid_on in the period, by rep, team (with the teams below) and business", async () => {
    expect(await collected(owner)).toEqual({
      [goal.org]: 1500000,
      [goal.north]: 1500000, // d1 (north) 1,000 + c1 (north) 6,000 + c2 (north-west) 8,000
      [goal.m1]: 700000,
      [goal.m2]: 800000,
    });
    expect(await collected(owner, "quarter", "2026-07-01")).toEqual({ [goal.orgQuarter]: 3100000 }); // August's payment too
    expect(await collected(owner, "month", "2026-10-01")).toEqual({ [goal.orgOctober]: 3200000 });
    // admins read every payment too
    expect(await collected(admin)).toEqual(await collected(owner));
  });

  it("shows a goal only to a caller who records payments and reads every payment it counts", async () => {
    // own visibility: m1 (the record_payments key) reads only their records' payments, so not the business's or the
    // team's (m2's are hidden)
    expect(await collected(m1)).toEqual({ [goal.m1]: 700000 });
    // m2 may not record payments: their own goal's actual is never shown, and the counting helper answers nothing
    expect(await collected(m2)).toEqual({});
    const n = await asUser(m2.id, async (q) => (await one<{ n: string | null }>(q, "select app.goal_payments_counted($1, $2) as n", [org, goal.m2])).n);
    expect(n).toBeNull();
    // the other metrics of m2 are untouched, and the goal row itself stays readable (the goals grid)
    const own = await asUser(m2.id, async (q) => (await q("select id from public.goals where id = $1", [goal.m2])).rowCount);
    expect(own).toBe(1);
    // the team's manager reads the team's records (and the team below), so the team goal and its people
    // and here every payment of the business is on north records, so the business goal too
    expect(await collected(manager)).toEqual({ [goal.org]: 1500000, [goal.north]: 1500000, [goal.m1]: 700000, [goal.m2]: 800000 });
    // a viewer reads the business's goal only, and not every payment under own visibility
    expect(await collected(viewer)).toEqual({});
  });

  it("hides a person's own goal once a payment credited to them sits on a deal they cannot read", async () => {
    await pay(10000, "2026-09-20", { deal: goal.dNoOwner, contact: goal.c1 }); // deal without owner, contact c1 (m1): credited to m1
    try {
      expect(await collected(owner)).toMatchObject({ [goal.m1]: 710000, [goal.org]: 1510000 });
      expect(await collected(m1)).toEqual({}); // partial: never shown as the full actual
    } finally {
      await asUser(owner.id, (q) =>
        q("update public.payments set status = 'cancelled', cancel_reason = 'בדיקה' where organization_id = $1 and deal_id = $2", [org, goal.dNoOwner]),
      );
    }
    expect(await collected(m1)).toEqual({ [goal.m1]: 700000 });
  });

  it("under org visibility a member who records payments sees the business goal when every payment is on a readable record", async () => {
    await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    try {
      expect(await collected(m1)).toMatchObject({ [goal.org]: 1500000, [goal.m1]: 700000 });
      // a member without the key still sees none
      expect(await collected(m2)).toEqual({});
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    }
  });

  it("needs the plan keys payments, documents and collection: no new goal or changed target, no actual", async () => {
    for (const key of ["payments", "documents", "collection"]) {
      await setFeatures({ ...FEATURES, [key]: false });
      try {
        const e = await pgError(addGoal(owner, { scope: "org", period_start: "2026-11-01" }));
        expect(e.hint).toBe(`feature:${key}`);
        const change = await pgError(asUser(owner.id, (q) => q("update public.goals set target = 5 where id = $1", [goal.m2])));
        expect(change.hint).toBe(`feature:${key}`);
        expect(await collected(owner)).toEqual({});
        const n = await asUser(owner.id, async (q) => (await one<{ n: string | null }>(q, "select app.goal_payments_counted($1, $2) as n", [org, goal.org])).n);
        expect(n).toBeNull();
      } finally {
        await setFeatures(FEATURES);
      }
    }
  });

  it("without the payments key: an unchanged write and a removal pass", async () => {
    await setFeatures({ ...FEATURES, payments: false });
    try {
      // an unchanged write still passes, and the other metrics are untouched
      await asUser(owner.id, (q) => q("update public.goals set target = target where id = $1", [goal.m2]));
      const won = await addGoal(owner, { scope: "org", metric: "won_amount", period_start: "2026-11-01" });
      expect(won).toBeTruthy();
      expect(await collected(owner)).toEqual({});
      const removed = await asUser(owner.id, async (q) => (await q("delete from public.goals where id = $1 returning id", [goal.orgOctober])).rowCount);
      expect(removed).toBe(1);
    } finally {
      await setFeatures(FEATURES);
    }
    expect(Object.keys(await collected(owner))).toHaveLength(4);
  });

  it("keeps the goal rules: a member cannot set one, a manager only for their team's members", async () => {
    const e = await pgError(addGoal(m1, { scope: "user", user_id: m1.id, period_start: "2026-12-01" }));
    expect(e.code).toBe("42501");
    const id = await addGoal(manager, { scope: "user", user_id: m1.id, period_start: "2026-12-01" });
    expect(id).toBeTruthy();
    const unknown = await pgError(addGoal(owner, { scope: "org", metric: "collections", period_start: "2026-12-01" }));
    expect(unknown.code).toBe("23514");
  });

  it("isolates businesses: an outsider gets nothing and cannot write, and their own goals count only their payments", async () => {
    expect(await progress(outsider)).toEqual([]);
    const e = await pgError(addGoal(outsider, { scope: "org", period_start: "2026-12-01" }));
    expect(e.code).toBe("42501");
    const theirs = await asUser(outsider.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.goals (organization_id, scope, period, period_start, metric, target) values ($1, 'org', 'month', $2, 'collected', 1) returning id",
          [otherOrg, SEP],
        )
      ).id,
    );
    expect(await progress(outsider, "month", SEP, otherOrg)).toEqual([expect.objectContaining({ goal_id: theirs, actual: 0 })]);
    // the counting helper answers nothing about a goal the caller does not read
    const count = await asUser(outsider.id, async (q) => (await one<{ n: string | null }>(q, "select app.goal_payments_counted($1, $2) as n", [org, goal.org])).n);
    expect(count).toBeNull();
  });
  it("a cheque counts once it is cleared or its due date has come; a bounced one never (owner's answer (17) ג)", async () => {
    const cheque = (amount: number, due: string, number: string) =>
      asUser(owner.id, async (q) =>
        (
          await one<{ id: string }>(
            q,
            `insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method, cheque_number, cheque_bank, cheque_branch, cheque_due_date, cheque_status)
             values ($1, $2, $3, '2026-09-05', 'cheque', $4, '12', '601', $5, 'in_hand') returning id`,
            [org, goal.c1, amount, number, due],
          )
        ).id,
      );
    const setStatus = (id: string, status: string) =>
      asUser(owner.id, (q) => q("update public.payments set cheque_status = $2 where id = $1", [id, status]));
    const due = await cheque(1000, "2026-09-25", "9001"); // due in the past: counts while in hand
    const deposited = await cheque(2000, "2026-09-26", "9002"); // deposited, due in the past: counts
    await setStatus(deposited, "deposited");
    const future = await cheque(4000, "2030-01-01", "9003"); // post-dated: not yet
    const bounced = await cheque(8000, "2026-09-27", "9004"); // bounced: never
    await setStatus(bounced, "bounced");
    try {
      expect(await collected(owner)).toMatchObject({ [goal.m1]: 703000, [goal.org]: 1503000 });
      // m1 (a recorder who reads c1) still sees the goal: the full count follows the same rule
      expect(await collected(m1)).toEqual({ [goal.m1]: 703000 });
      // the post-dated cheque counts once cleared, in the month of its paid_on
      await setStatus(future, "cleared");
      expect(await collected(owner)).toMatchObject({ [goal.m1]: 707000, [goal.org]: 1507000 });
      expect(await collected(m1)).toEqual({ [goal.m1]: 707000 });
    } finally {
      for (const id of [due, deposited, future, bounced]) {
        await asUser(owner.id, (q) => q("update public.payments set status = 'cancelled', cancel_reason = 'בדיקה' where id = $1 and status <> 'cancelled'", [id]));
      }
    }
    expect(await collected(owner)).toMatchObject({ [goal.m1]: 700000 });
  });
});
