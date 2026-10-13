import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asMfaUser, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Row = {
  goal_id: string;
  scope: string;
  user_id: string | null;
  team_id: string | null;
  period: string;
  period_start: string;
  metric: string;
  target: number;
  actual: number;
  elapsed: number;
};

// GOL-03: progress against goals. report_goal_progress is security invoker: the goals are the
// ones goals_select lets the caller read, and the actuals count what RLS lets them see.
describe("goal progress (GOL-03)", () => {
  let owner: U, admin: U, manager: U, m1: U, m2: U, outsider: U;
  let org: string;
  let north: string;
  let thisMonth: string;
  let lastMonth: string;
  const goal: Record<string, string> = {};

  const progress = (userId: string, args: unknown[] = []) =>
    asUser(userId, async (q) => {
      const params = [org, ...args];
      const list = params.map((_, i) => `$${i + 1}`).join(", ");
      return (await q<{ r: Row[] }>(`select public.report_goal_progress(${list}) as r`, params)).rows[0].r;
    });
  const byId = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.goal_id, r]));

  beforeAll(async () => {
    owner = await createUser("owner");
    outsider = await createUser("outsider");
    org = await createOrg(owner.id);
    await createOrg(outsider.id, "עסק אחר");
    admin = await addMember(org, owner.id, "admin");
    manager = await addMember(org, owner.id, "manager");
    m1 = await addMember(org, owner.id, "member", "m1");
    m2 = await addMember(org, owner.id, "member", "m2");

    [thisMonth, lastMonth] = await asAdmin(async (q) => {
      const r = (
        await q<{ a: string; b: string }>(
          `select to_char(date_trunc('month', now() at time zone 'Asia/Jerusalem'), 'YYYY-MM-DD') as a,
                  to_char(date_trunc('month', now() at time zone 'Asia/Jerusalem') - interval '1 month', 'YYYY-MM-DD') as b`,
        )
      ).rows[0];
      return [r.a, r.b];
    });

    north = await asUser(owner.id, async (q) => {
      const id = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'צפון') returning id", [org])).rows[0].id;
      await q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true), ($1, $2, $4, false)", [
        org,
        id,
        manager.id,
        m1.id,
      ]);
      return id;
    });
    // a team below north, with m2 in it: north's goal counts m2 too
    const child = await asUser(owner.id, async (q) => {
      const id = (await q<{ id: string }>("insert into public.teams (organization_id, name, parent_team_id) values ($1, 'צפון-מערב', $2) returning id", [org, north])).rows[0].id;
      await q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [org, id, m2.id]);
      return id;
    });
    expect(child).toBeTruthy();

    // deals: m1 won 1,000 now and 700 last month; m2 won 500 now; an unowned deal won 100 now; m1 has an open one
    await asAdmin(async (q) => {
      const p = (await q<{ id: string }>("select id from public.pipelines where organization_id = $1 and is_default", [org])).rows[0].id;
      const won = (await q<{ id: string }>("select id from public.stages where pipeline_id = $1 and kind = 'won' limit 1", [p])).rows[0].id;
      const open = (await q<{ id: string }>("select id from public.stages where pipeline_id = $1 and kind = 'open' order by position limit 1", [p])).rows[0].id;
      const deal = (name: string, owner: string | null, amount: number, stage: string, closed: string | null) =>
        q(
          `insert into public.deals (organization_id, name, owner_id, amount_agorot, pipeline_id, stage_id, closed_at)
           values ($1, $2, $3, $4, $5, $6, ${closed ?? "null"})`,
          [org, name, owner, amount, p, stage],
        );
      await deal("m1 now", m1.id, 100000, won, "now()");
      await deal("m1 last month", m1.id, 70000, won, `('${lastMonth}'::date + interval '10 days 12 hours') at time zone 'Asia/Jerusalem'`);
      await deal("m2 now", m2.id, 50000, won, "now()");
      await deal("nobody now", null, 10000, won, "now()");
      await deal("m1 open", m1.id, 999900, open, null);
    });

    // leads: one first contacted now; one first contacted last month and again now; one with only a private note
    const fresh = await insertLead(m1.id, org, { owner_id: m1.id });
    const older = await insertLead(m1.id, org, { owner_id: m1.id });
    const privateOnly = await insertLead(m1.id, org, { owner_id: m1.id });
    await asUser(m1.id, async (q) => {
      await q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'call', 'שיחה', $2)", [org, fresh]);
      await q(
        `insert into public.activities (organization_id, type, body, lead_id, occurred_at)
         values ($1, 'call', 'שיחה ישנה', $2, ($3::date + interval '5 days 12 hours') at time zone 'Asia/Jerusalem')`,
        [org, older, lastMonth],
      );
      await q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'call', 'שוב', $2)", [org, older]);
      await q("insert into public.activities (organization_id, type, body, lead_id, is_private) values ($1, 'note', 'פרטי', $2, true)", [org, privateOnly]);
      // a meeting logged by m1 now
      await q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'meeting', 'פגישה', $2)", [org, fresh]);
    });

    const add = (row: Record<string, unknown>) =>
      asUser(owner.id, async (q) => {
        const full = { organization_id: org, period: "month", period_start: thisMonth, metric: "won_amount", target: 200000, ...row };
        const cols = Object.keys(full);
        return (
          await q<{ id: string }>(
            `insert into public.goals (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
            Object.values(full),
          )
        ).rows[0].id;
      });
    goal.org = await add({ scope: "org" });
    goal.north = await add({ scope: "team", team_id: north });
    goal.m1 = await add({ scope: "user", user_id: m1.id });
    goal.m1Deals = await add({ scope: "user", user_id: m1.id, metric: "won_deals", target: 4 });
    goal.m1Leads = await add({ scope: "user", user_id: m1.id, metric: "leads_handled", target: 10 });
    goal.m1Meetings = await add({ scope: "user", user_id: m1.id, metric: "meetings_held", target: 5 });
    goal.m2 = await add({ scope: "user", user_id: m2.id, target: 0 });
    goal.m1Last = await add({ scope: "user", user_id: m1.id, period_start: lastMonth });
    // a year goal holds today too
    goal.orgYear = await add({ scope: "org", period: "year", period_start: `${thisMonth.slice(0, 4)}-01-01`, metric: "won_deals", target: 40 });
  });

  it("counts each metric by its report's definition, for a person, a team (with the teams below it) and the business", async () => {
    const rows = byId(await progress(owner.id));
    expect(Object.keys(rows).sort()).toEqual(
      [goal.org, goal.north, goal.m1, goal.m1Deals, goal.m1Leads, goal.m1Meetings, goal.m2, goal.orgYear].sort(),
    );
    // closed won this month: everything, including the deal with no owner
    expect(rows[goal.org].actual).toBe(160000);
    // north: m1 and m2 (team below), not the unowned deal
    expect(rows[goal.north].actual).toBe(150000);
    expect(rows[goal.m1].actual).toBe(100000);
    expect(rows[goal.m1Deals].actual).toBe(1);
    // first contact this month: the fresh lead only (the older one was first contacted last month; a private note is not contact)
    expect(rows[goal.m1Leads].actual).toBe(1);
    expect(rows[goal.m1Meetings].actual).toBe(1);
    expect(rows[goal.m2]).toMatchObject({ actual: 50000, target: 0 });
    // the year: at least this month's three won deals (and last month's, when it is the same year)
    expect(rows[goal.orgYear].actual).toBe(thisMonth.slice(0, 4) === lastMonth.slice(0, 4) ? 4 : 3);
    for (const row of Object.values(rows)) {
      expect(row.elapsed).toBeGreaterThan(0);
      expect(row.elapsed).toBeLessThanOrEqual(1);
    }
    // order: the business, teams, people
    expect((await progress(owner.id)).map((r) => r.scope)).toEqual(["org", "org", "team", "user", "user", "user", "user", "user"]);
  });

  it("an exact period returns that period's goals, with all of its time gone", async () => {
    const rows = await progress(owner.id, ["month", lastMonth]);
    expect(rows.map((r) => r.goal_id)).toEqual([goal.m1Last]);
    expect(rows[0]).toMatchObject({ actual: 70000, elapsed: 1, period_start: lastMonth });
  });

  it("p_user keeps only that person's own goals", async () => {
    const rows = await progress(m1.id, [null, null, m1.id]);
    expect(rows.map((r) => r.goal_id).sort()).toEqual([goal.m1, goal.m1Deals, goal.m1Leads, goal.m1Meetings].sort());
  });

  // Owner, 13 October 2026: only goals whose actual the caller sees in full. Records are read by
  // their team_id, while a goal counts what its people own, so under 'team' and 'own' visibility
  // only a person's own goals are whole (for a manager too); owners, admins and support see all.
  const ids = async (userId: string) => (await progress(userId)).map((r) => r.goal_id).sort();
  const setVisibility = (v: string) => asUser(owner.id, (q) => q("update public.organizations set record_visibility = $2 where id = $1", [org, v]));

  it("'org' visibility: everyone gets every goal they read, with the full actuals", async () => {
    expect(await ids(m1.id)).toEqual([goal.org, goal.north, goal.m1, goal.m1Deals, goal.m1Leads, goal.m1Meetings, goal.orgYear].sort());
    expect(byId(await progress(m1.id))[goal.org].actual).toBe(160000);
    // m2 does not read m1's goals
    expect(await ids(m2.id)).toEqual([goal.org, goal.m2, goal.orgYear].sort());
    // the manager reads north and the people in it (m1; m2 through the team below)
    expect(await ids(manager.id)).toEqual(
      [goal.org, goal.north, goal.m1, goal.m1Deals, goal.m1Leads, goal.m1Meetings, goal.m2, goal.orgYear].sort(),
    );
  });

  it.each(["team", "own"])(
    "'%s' visibility: a manager gets their teams' goals with exactly the deals they may read; members their own goals only",
    async (visibility) => {
      const managerGoal = await asUser(owner.id, async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.goals (organization_id, scope, user_id, period, period_start, metric, target) values ($1, 'user', $2, 'month', $3, 'won_amount', 1) returning id",
            [org, manager.id, thisMonth],
          )
        ).rows[0].id,
      );
      // a won deal of north owned by someone outside it, and one of m1's with no team: a team goal
      // counts by the record's team, a personal goal by its owner
      const extra = await asAdmin(async (q) => {
        const p = (await q<{ id: string }>("select id from public.pipelines where organization_id = $1 and is_default", [org])).rows[0].id;
        const won = (await q<{ id: string }>("select id from public.stages where pipeline_id = $1 and kind = 'won' limit 1", [p])).rows[0].id;
        const a = (
          await q<{ id: string }>(
            "insert into public.deals (organization_id, name, owner_id, team_id, amount_agorot, pipeline_id, stage_id, closed_at) values ($1, 'owner in north', $2, $3, 20000, $4, $5, now()) returning id",
            [org, owner.id, north, p, won],
          )
        ).rows[0].id;
        const b = (
          await q<{ id: string }>(
            "insert into public.deals (organization_id, name, owner_id, amount_agorot, pipeline_id, stage_id, closed_at) values ($1, 'm1 no team', $2, 5000, $3, $4, now()) returning id",
            [org, m1.id, p, won],
          )
        ).rows[0].id;
        await q("update public.deals set team_id = null where id = $1", [b]);
        return [a, b];
      });
      await setVisibility(visibility);
      try {
        // the manager: their own goal and north's (m1's and m2's personal goals count by owner, not shown)
        expect(await ids(manager.id)).toEqual([managerGoal, goal.north].sort());
        const north_ = byId(await progress(manager.id))[goal.north];
        // exactly the won deals of this month the manager can select in north and the team below it
        const visibleSum = await asUser(manager.id, async (q) =>
          Number(
            (
              await q<{ s: string }>(
                `select coalesce(sum(d.amount_agorot), 0) as s from public.deals d
                  where d.organization_id = $1 and d.status = 'won' and d.deleted_at is null
                    and d.closed_at >= ($2::date::timestamp at time zone 'Asia/Jerusalem')
                    and d.team_id in (select id from public.teams where organization_id = $1 and (id = $3 or parent_team_id = $3))`,
                [org, thisMonth, north],
              )
            ).rows[0].s,
          ),
        );
        expect(north_.actual).toBe(170000);
        expect(north_.actual).toBe(visibleSum);
        // m1: own goals only (north has a team below it that m1 is not in); the no-team deal is m1's.
        // Every meeting entry m1 wrote is on m1's own lead, so the meetings goal shows too.
        expect(await ids(m1.id)).toEqual([goal.m1, goal.m1Deals, goal.m1Leads, goal.m1Meetings].sort());
        expect(byId(await progress(m1.id))[goal.m1].actual).toBe(105000);
        expect(await ids(m2.id)).toEqual([goal.m2]);
        const all = [goal.org, goal.north, goal.m1, goal.m1Deals, goal.m1Leads, goal.m1Meetings, goal.m2, goal.orgYear, managerGoal].sort();
        expect(await ids(owner.id)).toEqual(all);
        expect(await ids(admin.id)).toEqual(all);
        const adminRows = byId(await progress(admin.id));
        expect(adminRows[goal.org].actual).toBe(185000);
        // the deal with no team is in no team's goal
        expect(adminRows[goal.north].actual).toBe(170000);
        // platform support in an open session sees what the admins see
        const support = await createUser("progress-support");
        await asAdmin(async (q) => {
          await q("insert into app.platform_staff (user_id, role) values ($1, 'support')", [support.id]);
          await q("insert into public.support_access_grants (organization_id, expires_at) values ($1, now() + interval '1 hour')", [org]);
        });
        try {
          const seen = await asMfaUser(support.id, async (q) =>
            (await q<{ r: Row[] }>("select public.report_goal_progress($1) as r", [org])).rows[0].r.map((r) => r.goal_id).sort(),
          );
          expect(seen).toEqual(all);
        } finally {
          await asAdmin((q) => q("update public.support_access_grants set revoked_at = now() where organization_id = $1 and revoked_at is null", [org]));
        }
      } finally {
        await setVisibility("org");
        await asAdmin(async (q) => {
          await q("delete from public.goals where id = $1", [managerGoal]);
          await q("delete from public.deals where id = any($1)", [extra]);
        });
      }
    },
  );

  it("under 'team' visibility a member in a team with no team below it gets that team's goal", async () => {
    const child = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.teams where organization_id = $1 and parent_team_id = $2", [org, north])).rows[0].id);
    const childGoal = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.goals (organization_id, scope, team_id, period, period_start, metric, target) values ($1, 'team', $2, 'month', $3, 'won_amount', 1) returning id",
          [org, child, thisMonth],
        )
      ).rows[0].id,
    );
    await setVisibility("team");
    try {
      expect(await ids(m2.id)).toEqual([childGoal, goal.m2].sort());
      expect(byId(await progress(m2.id))[childGoal].actual).toBe(50000);
      // under 'own' the member does not read the team's records
      await setVisibility("own");
      expect(await ids(m2.id)).toEqual([goal.m2]);
    } finally {
      await setVisibility("org");
      await asAdmin((q) => q("delete from public.goals where id = $1", [childGoal]));
    }
  });

  it.each(["team", "own"])(
    "'%s' visibility: a meeting m1 wrote on a record m1 may not read counts for owners and hides m1's own meetings goal",
    async (visibility) => {
      const othersLead = await insertLead(owner.id, org, { owner_id: m2.id });
      const entry = await asAdmin(async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.activities (organization_id, type, body, lead_id, created_by) values ($1, 'meeting', 'פגישה', $2, $3) returning id",
            [org, othersLead, m1.id],
          )
        ).rows[0].id,
      );
      await setVisibility(visibility);
      try {
        expect(byId(await progress(owner.id))[goal.m1Meetings].actual).toBe(2);
        expect(await ids(m1.id)).not.toContain(goal.m1Meetings);
        // the helper answers only about the caller's own entries
        const readable = (userId: string, who: string) =>
          asUser(userId, async (q) =>
            (
              await q<{ r: boolean }>("select app.goal_entries_readable($1, $2, now() - interval '40 days', now() + interval '1 day') as r", [org, who])
            ).rows[0].r,
          );
        expect(await readable(m1.id, m1.id)).toBe(false);
        expect(await readable(owner.id, m1.id)).toBe(false);
        expect(await readable(m2.id, m2.id)).toBe(true);
      } finally {
        await setVisibility("org");
        await asAdmin((q) => q("delete from public.activities where id = $1", [entry]));
      }
      expect(await ids(m1.id)).toContain(goal.m1Meetings);
    },
  );

  it("a suspended member gets nothing; a viewer under 'team' visibility only their own goals", async () => {
    const viewer = await addMember(org, owner.id, "viewer", "progress-viewer");
    const viewerGoal = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.goals (organization_id, scope, user_id, period, period_start, metric, target) values ($1, 'user', $2, 'month', $3, 'won_deals', 1) returning id",
          [org, viewer.id, thisMonth],
        )
      ).rows[0].id,
    );
    await setVisibility("team");
    try {
      expect(await ids(viewer.id)).toEqual([viewerGoal]);
    } finally {
      await setVisibility("org");
    }
    await asUser(owner.id, (q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, m2.id]));
    try {
      expect(await progress(m2.id)).toEqual([]);
    } finally {
      await asUser(owner.id, (q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, m2.id]));
    }
  });

  it("platform support who is also a member is judged by the membership", async () => {
    const staff = await addMember(org, owner.id, "member", "support-member");
    await asAdmin(async (q) => {
      await q("insert into app.platform_staff (user_id, role) values ($1, 'support')", [staff.id]);
      await q("insert into public.support_access_grants (organization_id, expires_at) values ($1, now() + interval '1 hour')", [org]);
    });
    await setVisibility("own");
    try {
      const seen = await asMfaUser(staff.id, async (q) => (await q<{ r: Row[] }>("select public.report_goal_progress($1) as r", [org])).rows[0].r);
      expect(seen).toEqual([]);
    } finally {
      await setVisibility("org");
      await asAdmin((q) => q("update public.support_access_grants set revoked_at = now() where organization_id = $1 and revoked_at is null", [org]));
    }
  });

  it("a meeting entry on a lead of one team and a deal of another counts for the same team whoever looks", async () => {
    const other = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'אחר') returning id", [org])).rows[0].id,
    );
    const northMeetings = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.goals (organization_id, scope, team_id, period, period_start, metric, target) values ($1, 'team', $2, 'month', $3, 'meetings_held', 10) returning id",
          [org, north, thisMonth],
        )
      ).rows[0].id,
    );
    const lead = await insertLead(m1.id, org, { owner_id: m1.id });
    const made = await asAdmin(async (q) => {
      const p = (await q<{ id: string }>("select id from public.pipelines where organization_id = $1 and is_default", [org])).rows[0].id;
      const open = (await q<{ id: string }>("select id from public.stages where pipeline_id = $1 and kind = 'open' order by position limit 1", [p])).rows[0].id;
      const deal = (
        await q<{ id: string }>(
          "insert into public.deals (organization_id, name, owner_id, team_id, amount_agorot, pipeline_id, stage_id) values ($1, 'deal of other', $2, $3, 1, $4, $5) returning id",
          [org, owner.id, other, p, open],
        )
      ).rows[0].id;
      const entry = (
        await q<{ id: string }>(
          "insert into public.activities (organization_id, type, body, lead_id, deal_id, created_by) values ($1, 'meeting', 'פגישה', $2, $3, $4) returning id",
          [org, lead, deal, m1.id],
        )
      ).rows[0].id;
      return { deal, entry };
    });
    await setVisibility("own");
    try {
      const forOwner = byId(await progress(owner.id))[northMeetings].actual;
      const forManager = byId(await progress(manager.id))[northMeetings].actual;
      // the entry is the deal's team's (other), not north's, for both
      expect(forOwner).toBe(1);
      expect(forManager).toBe(forOwner);
      // the helper names a team only to someone who may read that team's records
      const team = (userId: string) =>
        asUser(userId, async (q) =>
          (await q<{ t: string | null }>("select app.activity_goal_team($1, $2, $3, null, null) as t", [org, made.deal, lead])).rows[0].t,
        );
      expect(await team(owner.id)).toBe(other);
      expect(await team(manager.id)).toBeNull();
    } finally {
      await setVisibility("org");
      await asAdmin(async (q) => {
        await q("delete from public.activities where id = $1", [made.entry]);
        await q("delete from public.deals where id = $1", [made.deal]);
        await q("delete from public.goals where id = $1", [northMeetings]);
        await q("delete from public.teams where id = $1", [other]);
      });
    }
  });

  it("a team tree deeper than the manager reaches is not whole for that manager", async () => {
    const boss = await addMember(org, owner.id, "manager", "deep-boss");
    const { root, teams } = await asUser(owner.id, async (q) => {
      const parent = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'עליון') returning id", [org])).rows[0].id;
      await q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true)", [org, parent, boss.id]);
      const made: string[] = [parent];
      let up = parent;
      // root under the boss's team, then a chain of 9 below root: root's last level is 11 steps from the boss's team
      for (let i = 0; i < 10; i++) {
        up = (await q<{ id: string }>("insert into public.teams (organization_id, name, parent_team_id) values ($1, $2, $3) returning id", [org, `שכבה ${i}`, up])).rows[0].id;
        made.push(up);
      }
      return { root: made[1], teams: made };
    });
    const deepGoal = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.goals (organization_id, scope, team_id, period, period_start, metric, target) values ($1, 'team', $2, 'month', $3, 'won_amount', 1) returning id",
          [org, root, thisMonth],
        )
      ).rows[0].id,
    );
    try {
      // under 'org' visibility the whole tree is readable
      expect(await ids(boss.id)).toContain(deepGoal);
      await setVisibility("own");
      try {
        // the lowest team is beyond the boss's reach (app.manages_team walks up 10 levels)
        expect(await ids(boss.id)).not.toContain(deepGoal);
      } finally {
        await setVisibility("org");
      }
    } finally {
      await asAdmin(async (q) => {
        await q("delete from public.goals where id = $1", [deepGoal]);
        await q("delete from public.teams where id = any($1)", [teams]);
      });
    }
  });

  it("entries dated more than 5 minutes ahead are not counted", async () => {
    const lead = await insertLead(m1.id, org, { owner_id: m1.id });
    await asAdmin((q) =>
      q(
        `insert into public.activities (organization_id, type, body, lead_id, created_by, occurred_at)
         values ($1, 'call', 'עתידית', $2, $3, now() + interval '1 hour'), ($1, 'meeting', 'עתידית', $2, $3, now() + interval '1 hour')`,
        [org, lead, m1.id],
      ),
    );
    const rows = byId(await progress(owner.id));
    expect(rows[goal.m1Leads].actual).toBe(1);
    expect(rows[goal.m1Meetings].actual).toBe(1);
  });

  it("outsiders get nothing and anonymous callers may not run it", async () => {
    expect(await progress(outsider.id)).toEqual([]);
    expect((await pgError(asAnon((q) => q("select public.report_goal_progress($1)", [org])))).code).toBe("42501");
  });

  it("is security invoker", async () => {
    const definer = await asAdmin(async (q) => (await q<{ d: boolean }>("select prosecdef as d from pg_proc where proname = 'report_goal_progress'")).rows[0].d);
    expect(definer).toBe(false);
  });
});
