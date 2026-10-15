import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOAL_METRIC_KEYS, GOAL_PERIODS, GOAL_SCOPES } from "../../src/features/goals/metrics";
import { addMember, asAdmin, asAnon, asMfaUser, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

// GOL-01: goals for a person, a team or the whole organization, per month, quarter or year.
// Owners and admins write every goal, managers those of their teams and people (spec 22.9 "יעדים: מנהלים").
describe("goals (GOL-01)", () => {
  let owner: U, admin: U, manager: U, m1: U, m2: U, viewer: U, outsider: U;
  let org: string;
  let other: string;
  let teamNorth: string;
  let teamSouth: string;
  const ids: Record<string, string> = {};

  const insertGoal = (userId: string, row: Record<string, unknown>) => {
    const full = { organization_id: org, period: "month", period_start: "2026-10-01", metric: "won_amount", target: 100000, ...row };
    const columns = Object.keys(full);
    return asUser(userId, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.goals (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
          Object.values(full),
        )
      ).rows[0].id,
    );
  };
  const visible = (userId: string) =>
    asUser(userId, async (q) =>
      (await q<{ id: string }>("select id from public.goals where organization_id = $1", [org])).rows.map((r) => r.id).sort(),
    );
  const pick = (...keys: string[]) => keys.map((k) => ids[k]).sort();

  beforeAll(async () => {
    owner = await createUser("owner");
    outsider = await createUser("outsider");
    org = await createOrg(owner.id);
    other = await createOrg(outsider.id, "עסק אחר");
    admin = await addMember(org, owner.id, "admin");
    manager = await addMember(org, owner.id, "manager");
    m1 = await addMember(org, owner.id, "member", "m1");
    m2 = await addMember(org, owner.id, "member", "m2");
    viewer = await addMember(org, owner.id, "viewer");

    [teamNorth, teamSouth] = await asUser(admin.id, async (q) => {
      const north = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'צפון') returning id", [org])).rows[0].id;
      const south = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'דרום') returning id", [org])).rows[0].id;
      await q(
        "insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true), ($1, $2, $4, false), ($1, $5, $6, false)",
        [org, north, manager.id, m1.id, south, m2.id],
      );
      return [north, south];
    });

    ids.org = await insertGoal(admin.id, { scope: "org" });
    ids.m1 = await insertGoal(admin.id, { scope: "user", user_id: m1.id });
    ids.m2 = await insertGoal(owner.id, { scope: "user", user_id: m2.id, metric: "won_deals", target: 5 });
    ids.manager = await insertGoal(owner.id, { scope: "user", user_id: manager.id });
    ids.north = await insertGoal(admin.id, { scope: "team", team_id: teamNorth, period: "quarter", period_start: "2026-10-01" });
    ids.south = await insertGoal(admin.id, { scope: "team", team_id: teamSouth, period: "year", period_start: "2026-01-01", metric: "meetings_held", target: 40 });
  });

  it("the metric, period and scope lists match the app's", () => {
    const sql = readFileSync(path.resolve(__dirname, "../../supabase/migrations/20261006013300_goals.sql"), "utf8");
    const list = (name: string) => {
      const match = new RegExp(`constraint ${name} check \\(\\w+ in \\(([^)]*)\\)\\)`).exec(sql);
      return match ? [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];
    };
    expect(list("goals_metric_check")).toEqual(GOAL_METRIC_KEYS);
    expect(list("goals_period_check")).toEqual([...GOAL_PERIODS]);
    const scopeCheck = sql.slice(sql.indexOf("constraint goals_scope_check"), sql.indexOf("constraint goals_period_check"));
    expect([...scopeCheck.matchAll(/scope = '([a-z]+)'/g)].map((m) => m[1])).toEqual([...GOAL_SCOPES]);
  });

  it("owners and admins read every goal", async () => {
    const all = pick("org", "m1", "m2", "manager", "north", "south");
    expect(await visible(owner.id)).toEqual(all);
    expect(await visible(admin.id)).toEqual(all);
  });

  it("a member reads the organization's goals, their own and their team's", async () => {
    expect(await visible(m1.id)).toEqual(pick("org", "m1", "north"));
    expect(await visible(m2.id)).toEqual(pick("org", "m2", "south"));
  });

  it("a manager also reads the goals of the teams they manage and of the people in them", async () => {
    expect(await visible(manager.id)).toEqual(pick("org", "manager", "m1", "north"));
  });

  it("a viewer reads only the organization's goals; outsiders and anonymous callers nothing", async () => {
    expect(await visible(viewer.id)).toEqual(pick("org"));
    expect(await visible(outsider.id)).toEqual([]);
    expect((await pgError(asAnon((q) => q("select 1 from public.goals")))).code).toBe("42501");
  });

  it("platform support in an open session reads every goal and writes none", async () => {
    const support = await createUser("goals-support");
    await asAdmin(async (q) => {
      await q("insert into app.platform_staff (user_id, role) values ($1, 'support')", [support.id]);
      await q("insert into public.support_access_grants (organization_id, expires_at) values ($1, now() + interval '1 hour')", [org]);
    });
    await asMfaUser(support.id, (q) => q("select public.platform_open_support($1)", [org]));
    const all = pick("org", "m1", "m2", "manager", "north", "south");
    expect(await asMfaUser(support.id, async (q) => (await q<{ id: string }>("select id from public.goals where organization_id = $1", [org])).rows.map((r) => r.id).sort())).toEqual(all);
    expect(await asMfaUser(support.id, async (q) => (await q("update public.goals set target = target where organization_id = $1", [org])).rowCount)).toBe(0);
    expect(await asMfaUser(support.id, async (q) => (await q("delete from public.goals where organization_id = $1", [org])).rowCount)).toBe(0);
    await asAdmin((q) => q("update public.support_access_grants set revoked_at = now() where organization_id = $1", [org]));
    expect(await asMfaUser(support.id, (q) => count(q, "select 1 from public.goals where organization_id = $1", [org]))).toBe(0);
  });

  it("a manager of a parent team reads the goals of the child team and its people", async () => {
    const child = await asUser(admin.id, async (q) => {
      const id = (await q<{ id: string }>("insert into public.teams (organization_id, name, parent_team_id) values ($1, 'צפון-מערב', $2) returning id", [org, teamNorth])).rows[0].id;
      await q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [org, id, m2.id]);
      return id;
    });
    // the manager of the parent team writes the child team's goals and its people's
    const childGoal = await insertGoal(manager.id, { scope: "team", team_id: child });
    const childPerson = await insertGoal(manager.id, { scope: "user", user_id: m2.id, metric: "leads_handled" });
    try {
      expect(await visible(manager.id)).toContain(childPerson);
      const seen = await visible(manager.id);
      expect(seen).toContain(childGoal);
      expect(seen).toContain(ids.m2);
      // m2's team goal of the south team is still not the manager's
      expect(seen).not.toContain(ids.south);
    } finally {
      await asAdmin((q) => q("delete from public.teams where id = $1", [child]));
      await asAdmin((q) => q("delete from public.goals where id = $1", [childPerson]));
    }
    expect(await visible(manager.id)).toEqual(pick("org", "manager", "m1", "north"));
  });

  it("members and viewers write nothing", async () => {
    for (const u of [m1, m2, viewer]) {
      const err = await pgError(insertGoal(u.id, { scope: "user", user_id: u.id, metric: "leads_handled" }));
      expect(err.code, u.email).toBe("42501");
      await asUser(u.id, async (q) => {
        expect((await q("update public.goals set target = 1 where organization_id = $1", [org])).rowCount, u.email).toBe(0);
        expect((await q("delete from public.goals where organization_id = $1", [org])).rowCount, u.email).toBe(0);
      });
    }
    await asUser(admin.id, async (q) => {
      expect((await q("update public.goals set target = 200000 where id = $1", [ids.m1])).rowCount).toBe(1);
    });
    expect(await asAdmin((q) => count(q, "select 1 from public.goals where organization_id = $1 and target = 1", [org]))).toBe(0);
  });

  it("a manager writes the goals of the teams they manage and of the people in them, nothing else", async () => {
    // not the business, not another team, not a person outside their teams, not themselves
    for (const row of [
      { scope: "org", metric: "leads_handled" },
      { scope: "team", team_id: teamSouth, metric: "leads_handled" },
      { scope: "user", user_id: m2.id, metric: "leads_handled" },
      { scope: "user", user_id: manager.id, metric: "leads_handled" },
    ]) {
      expect((await pgError(insertGoal(manager.id, row))).code, JSON.stringify(row)).toBe("42501");
    }
    const own = [
      await insertGoal(manager.id, { scope: "user", user_id: m1.id, metric: "leads_handled", target: 30 }),
      await insertGoal(manager.id, { scope: "team", team_id: teamNorth, metric: "leads_handled", target: 90 }),
    ];
    await asUser(manager.id, async (q) => {
      for (const id of [ids.org, ids.m2, ids.manager, ids.south]) {
        expect((await q("update public.goals set target = 1 where id = $1", [id])).rowCount, id).toBe(0);
        expect((await q("delete from public.goals where id = $1", [id])).rowCount, id).toBe(0);
      }
      expect((await q("update public.goals set target = 35 where id = $1", [own[0]])).rowCount).toBe(1);
      expect((await q("update public.goals set target = 95 where id = $1", [own[1]])).rowCount).toBe(1);
      expect((await q("delete from public.goals where id = any($1::uuid[])", [own])).rowCount).toBe(2);
    });
    expect(await asAdmin((q) => count(q, "select 1 from public.goals where organization_id = $1 and target = 1", [org]))).toBe(0);
    // a person who left the manager's team is no longer theirs to change
    const later = await insertGoal(admin.id, { scope: "user", user_id: m1.id, metric: "won_deals", target: 3 });
    await asAdmin((q) => q("delete from public.team_members where team_id = $1 and user_id = $2", [teamNorth, m1.id]));
    try {
      await asUser(manager.id, async (q) => {
        expect((await q("update public.goals set target = 4 where id = $1", [later])).rowCount).toBe(0);
      });
    } finally {
      await asAdmin((q) => q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [org, teamNorth, m1.id]));
      await asAdmin((q) => q("delete from public.goals where id = $1", [later]));
    }
  });

  it("who, period and metric are fixed once written; only the target changes", async () => {
    for (const set of ["user_id = null", "scope = 'org'", "metric = 'won_deals'", "period_start = '2026-11-01'", "organization_id = organization_id"]) {
      const err = await pgError(asUser(admin.id, (q) => q(`update public.goals set ${set} where id = $1`, [ids.m1])));
      expect(err.code, set).toBe("42501");
    }
  });

  it("the shape of a goal is checked", async () => {
    const bad: [Record<string, unknown>, string][] = [
      [{ scope: "user" }, "23514"],
      [{ scope: "org", user_id: m1.id }, "23514"],
      [{ scope: "team", team_id: teamNorth, user_id: m1.id }, "23514"],
      [{ scope: "everyone" }, "23514"],
      [{ scope: "org", period: "week" }, "23514"],
      [{ scope: "org", period_start: "2026-10-02" }, "23514"],
      [{ scope: "org", period: "quarter", period_start: "2026-11-01" }, "23514"],
      [{ scope: "org", period: "year", period_start: "2026-10-01" }, "23514"],
      [{ scope: "org", period_start: "1999-12-01" }, "23514"],
      [{ scope: "org", metric: "collections" }, "23514"],
      [{ scope: "org", target: -1 }, "23514"],
      [{ scope: "org", target: 100000000001 }, "23514"],
      // one goal per person, period and metric (also for the organization, whose user and team are null)
      [{ scope: "org" }, "23505"],
      [{ scope: "user", user_id: m1.id }, "23505"],
      // a person or a team of another organization
      [{ scope: "user", user_id: outsider.id }, "23503"],
    ];
    for (const [row, code] of bad) {
      expect((await pgError(insertGoal(admin.id, row))).code, JSON.stringify(row)).toBe(code);
    }
    const foreignTeam = await asUser(outsider.id, async (q) =>
      (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'זר') returning id", [other])).rows[0].id,
    );
    expect((await pgError(insertGoal(admin.id, { scope: "team", team_id: foreignTeam }))).code).toBe("23503");
    // the same person, another metric or month, is a separate goal
    await insertGoal(admin.id, { scope: "user", user_id: m1.id, period_start: "2026-11-01" });
    await insertGoal(admin.id, { scope: "user", user_id: m1.id, metric: "meetings_held", target: 12 });
  });

  it("is audited", async () => {
    const entries = await asAdmin((q) =>
      count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type = 'goals' and entity_id = $2", [org, ids.m1]),
    );
    expect(entries).toBeGreaterThanOrEqual(2);
  });

  it("a read-only organization keeps its goals but cannot change them", async () => {
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect(await visible(m1.id)).toContain(ids.m1);
      expect((await pgError(insertGoal(admin.id, { scope: "org", metric: "won_deals" }))).code).toBe("42501");
      expect((await pgError(insertGoal(manager.id, { scope: "user", user_id: m1.id, metric: "won_deals" }))).code).toBe("42501");
      await asUser(manager.id, async (q) => {
        expect((await q("update public.goals set target = 5 where id = $1", [ids.m1])).rowCount).toBe(0);
      });
      await asUser(owner.id, async (q) => {
        expect((await q("update public.goals set target = 5 where id = $1", [ids.org])).rowCount).toBe(0);
        expect((await q("delete from public.goals where id = $1", [ids.org])).rowCount).toBe(0);
      });
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
  });

  it("a manager never sets goals for an owner, an admin or another manager, even in their team", async () => {
    const other = await addMember(org, owner.id, "manager", "manager2");
    await asAdmin((q) =>
      q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3), ($1, $2, $4), ($1, $2, $5)", [
        org,
        teamNorth,
        owner.id,
        admin.id,
        other.id,
      ]),
    );
    try {
      for (const person of [owner, admin, other]) {
        expect((await pgError(insertGoal(manager.id, { scope: "user", user_id: person.id, metric: "meetings_held" }))).code, person.email).toBe("42501");
      }
      const adminsGoal = await insertGoal(owner.id, { scope: "user", user_id: admin.id, metric: "meetings_held" });
      await asUser(manager.id, async (q) => {
        // the manager reads it (the person is in their team) but does not change it
        expect(await count(q, "select 1 from public.goals where id = $1", [adminsGoal])).toBe(1);
        expect((await q("update public.goals set target = 9 where id = $1", [adminsGoal])).rowCount).toBe(0);
        expect((await q("delete from public.goals where id = $1", [adminsGoal])).rowCount).toBe(0);
      });
      await asAdmin((q) => q("delete from public.goals where id = $1", [adminsGoal]));
    } finally {
      await asAdmin((q) =>
        q("delete from public.team_members where team_id = $1 and user_id = any($2::uuid[])", [teamNorth, [owner.id, admin.id, other.id]]),
      );
    }
  });

  it("the team manager flag alone is not a manager: a member marked as one reads and writes nothing more", async () => {
    // m2 is marked manager of the south team, with a team under it that m2 is not in
    const below = await asAdmin(async (q) => {
      await q("update public.team_members set is_manager = true where team_id = $1 and user_id = $2", [teamSouth, m2.id]);
      return (await q<{ id: string }>("insert into public.teams (organization_id, name, parent_team_id) values ($1, 'דרום-מזרח', $2) returning id", [org, teamSouth])).rows[0].id;
    });
    const belowGoal = await insertGoal(admin.id, { scope: "team", team_id: below });
    try {
      expect(await visible(m2.id)).not.toContain(belowGoal);
      expect((await pgError(insertGoal(m2.id, { scope: "team", team_id: below, metric: "won_deals" }))).code).toBe("42501");
      await asUser(m2.id, async (q) => {
        expect((await q("update public.goals set target = 1 where id = $1", [belowGoal])).rowCount).toBe(0);
      });
    } finally {
      await asAdmin(async (q) => {
        await q("delete from public.teams where id = $1", [below]);
        await q("update public.team_members set is_manager = false where team_id = $1 and user_id = $2", [teamSouth, m2.id]);
      });
    }
  });

  it("a goal goes with its team and with its member", async () => {
    const temp = await addMember(org, owner.id, "member", "temp");
    const goal = await insertGoal(admin.id, { scope: "user", user_id: temp.id });
    await asAdmin((q) => q("delete from public.memberships where organization_id = $1 and user_id = $2", [org, temp.id]));
    expect(await asAdmin((q) => count(q, "select 1 from public.goals where id = $1", [goal]))).toBe(0);

    await asUser(admin.id, async (q) => {
      expect((await q("delete from public.teams where id = $1", [teamSouth])).rowCount).toBe(1);
    });
    expect(await asAdmin((q) => count(q, "select 1 from public.goals where id = $1", [ids.south]))).toBe(0);
  });

  it("an admin deletes a goal", async () => {
    await asUser(owner.id, async (q) => {
      expect((await q("delete from public.goals where id = $1", [ids.manager])).rowCount).toBe(1);
    });
  });
});
