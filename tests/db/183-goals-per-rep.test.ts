import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

// RVW-22: a goal per rep or per team needs the plan key goals_per_rep (owner, 13 October 2026:
// one goal for the business on every plan, per rep and per team from "מקצועי" up).
describe("goals per rep and per team need goals_per_rep (RVW-22)", () => {
  let owner: U, manager: U, m1: U, outsider: U;
  let org: string;
  let other: string;
  let team: string;
  let oldUserGoal: string;
  let oldTeamGoal: string;

  const setFlag = (o: string, on: boolean) =>
    asAdmin((q) =>
      q(
        "update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || jsonb_build_object('goals_per_rep', $2::boolean) where organization_id = $1",
        [o, on],
      ),
    );
  const insertGoal = (userId: string, o: string, row: Record<string, unknown>) => {
    const full = { organization_id: o, period: "month", period_start: "2026-10-01", metric: "won_amount", target: 1000, ...row };
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
  const setTarget = (userId: string, id: string, target: number) =>
    asUser(userId, async (q) => (await q("update public.goals set target = $2 where id = $1", [id, target])).rowCount);

  beforeAll(async () => {
    owner = await createUser("owner");
    outsider = await createUser("outsider");
    org = await createOrg(owner.id);
    other = await createOrg(outsider.id, "עסק אחר");
    manager = await addMember(org, owner.id, "manager");
    m1 = await addMember(org, owner.id, "member", "m1");
    team = await asUser(owner.id, async (q) => {
      const id = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'צפון') returning id", [org])).rows[0].id;
      await q(
        "insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true), ($1, $2, $4, false)",
        [org, id, manager.id, m1.id],
      );
      return id;
    });
    // goals made while the plan had the key; then the business moves to a plan without it
    await setFlag(org, true);
    oldUserGoal = await insertGoal(owner.id, org, { scope: "user", user_id: m1.id });
    oldTeamGoal = await insertGoal(owner.id, org, { scope: "team", team_id: team });
    await setFlag(org, false);
  });

  it("without the key: one goal for the business is fine, a new goal per rep or per team is refused, for managers too", async () => {
    await insertGoal(owner.id, org, { scope: "org" });
    for (const [who, row] of [
      [owner, { scope: "user", user_id: m1.id, metric: "won_deals" }],
      [owner, { scope: "team", team_id: team, metric: "won_deals" }],
      [manager, { scope: "user", user_id: m1.id, metric: "leads_handled" }],
      [manager, { scope: "team", team_id: team, metric: "leads_handled" }],
    ] as const) {
      const e = await pgError(insertGoal(who.id, org, row));
      expect(e.code, `${who.email} ${row.scope}`).toBe("P0001");
      expect(e.hint).toBe("feature:goals_per_rep");
    }
    // a server writer is held to the same rule
    const e = await pgError(
      asAdmin((q) =>
        q(
          "insert into public.goals (organization_id, scope, user_id, period, period_start, metric, target) values ($1, 'user', $2, 'year', '2026-01-01', 'won_amount', 5)",
          [org, m1.id],
        ),
      ),
    );
    expect(e.hint).toBe("feature:goals_per_rep");
  });

  it("without the key: existing goals stay, are read, can be removed, and a no-op write passes; changing their target is refused", async () => {
    const seen = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("select id from public.goals where id = any($1)", [[oldUserGoal, oldTeamGoal]])).rows.length,
    );
    expect(seen).toBe(2);
    expect(await setTarget(owner.id, oldUserGoal, 1000)).toBe(1);
    const e = await pgError(setTarget(owner.id, oldUserGoal, 2000));
    expect(e.hint).toBe("feature:goals_per_rep");
    expect((await pgError(setTarget(manager.id, oldTeamGoal, 2000))).hint).toBe("feature:goals_per_rep");
    // the org goal's target still changes
    const orgGoal = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("select id from public.goals where organization_id = $1 and scope = 'org'", [org])).rows[0].id,
    );
    expect(await setTarget(owner.id, orgGoal, 3000)).toBe(1);
    // the rows are still there after the refusals
    const targets = await asAdmin(async (q) =>
      (await q<{ target: string }>("select target::text from public.goals where id = any($1) order by target", [[oldUserGoal, oldTeamGoal]])).rows.map((r) => r.target),
    );
    expect(targets).toEqual(["1000", "1000"]);
    expect(await asUser(owner.id, async (q) => (await q("delete from public.goals where id = $1", [oldTeamGoal])).rowCount)).toBe(1);
  });

  it("with the key: goals per rep and per team are written and changed as before", async () => {
    await setFlag(org, true);
    try {
      await insertGoal(owner.id, org, { scope: "team", team_id: team, period: "quarter" });
      await insertGoal(manager.id, org, { scope: "user", user_id: m1.id, period: "quarter" });
      expect(await setTarget(owner.id, oldUserGoal, 2500)).toBe(1);
    } finally {
      await setFlag(org, false);
    }
  });

  it("an outsider gets the plain refusal, never the plan hint of another business", async () => {
    // the other business lacks the key too: the trigger would answer with the hint if it ran first
    await setFlag(other, false);
    const e = await pgError(insertGoal(owner.id, other, { scope: "user", user_id: outsider.id }));
    expect(e.code).toBe("42501");
    expect(e.hint ?? "").not.toBe("feature:goals_per_rep");
  });
});
