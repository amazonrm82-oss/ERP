import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * TASK-07 (owner, 18 October 2026): a task for a team with no owner. Every member of the team sees it until someone
 * takes it; the first "לקחתי" wins; the team's full-seat members get one notice when it is made, and after it is taken
 * notices go to the taker only.
 */
describe("team tasks: first to take it becomes the owner (TASK-07)", () => {
  let owner: U, admin: U, manager: U, m1: U, m2: U, m3: U, viewer: U, outsider: U;
  let org: string;
  let team: string;
  let other: string;

  const teamTask = (who: U, title: string, t = team) =>
    asUser(who.id, async (q) =>
      (await q<{ id: string; owner_id: string | null }>("insert into public.tasks (organization_id, title, team_id) values ($1, $2, $3) returning id, owner_id", [org, title, t]))
        .rows[0],
    );
  const take = (who: U, task: string) =>
    asUser(who.id, async (q) => (await q<{ r: Record<string, unknown> }>("select public.take_task($1, $2) as r", [org, task])).rows[0].r);
  const sees = (who: U, task: string) => asUser(who.id, async (q) => (await count(q, "select 1 from public.tasks where id = $1", [task])) === 1);
  const noticesOf = (task: string) =>
    asAdmin(async (q) => (await q<{ user_id: string; type: string }>("select user_id, type from public.notifications where entity_type = 'task' and entity_id = $1 order by user_id", [task])).rows);

  beforeAll(async () => {
    owner = await createUser("tt-owner");
    org = await createOrg(owner.id, "עסק צוותים");
    admin = await addMember(org, owner.id, "admin", "tt-admin");
    manager = await addMember(org, owner.id, "manager", "tt-manager");
    m1 = await addMember(org, owner.id, "member", "tt-m1");
    m2 = await addMember(org, owner.id, "member", "tt-m2");
    m3 = await addMember(org, owner.id, "member", "tt-m3");
    viewer = await addMember(org, owner.id, "viewer", "tt-viewer");
    outsider = await createUser("tt-outsider");
    await createOrg(outsider.id, "עסק אחר");
    [team, other] = await asUser(owner.id, async (q) => {
      const t = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'שירות') returning id", [org])).rows[0].id;
      const o = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'מכירות') returning id", [org])).rows[0].id;
      await q(
        `insert into public.team_members (organization_id, team_id, user_id, is_manager) values
           ($1, $2, $3, true), ($1, $2, $4, false), ($1, $2, $5, false), ($1, $2, $6, false), ($1, $7, $5, false)`,
        [org, t, manager.id, m1.id, m2.id, viewer.id, o],
      );
      // m2's primary team is the other one: taking a task must not move it there
      await q("update public.team_members set is_primary = (team_id = $3) where organization_id = $1 and user_id = $2", [org, m2.id, o]);
      await q("update public.organizations set record_visibility = 'own' where id = $1", [org]);
      return [t, o];
    });
  });

  it("a team member, the team's manager or an admin makes a team task with no owner; someone outside the team may not", async () => {
    for (const who of [m1, manager, admin]) {
      const t = await teamTask(who, `משימה של ${who.email}`);
      expect(t.owner_id, who.email).toBeNull();
    }
    const refused = await pgError(teamTask(m3, "לא בצוות"));
    expect(refused).toMatchObject({ code: "42501", hint: "task:team" });
    expect((await pgError(teamTask(viewer, "צופה"))).code).toBe("42501");
    // without a team the creator owns it, as before
    const own = await asUser(m3.id, async (q) => (await q<{ owner_id: string }>("insert into public.tasks (organization_id, title) values ($1, 'שלי') returning owner_id", [org])).rows[0].owner_id);
    expect(own).toBe(m3.id);
  });

  it("every member of the team sees it until someone takes it; then the owner rules apply again", async () => {
    const t = await teamTask(m1, "לחזור ללקוח");
    for (const who of [m1, m2, viewer, manager, admin, owner]) expect(await sees(who, t.id), who.email).toBe(true);
    expect(await sees(m3, t.id)).toBe(false);
    expect(await sees(outsider, t.id)).toBe(false);
    // a team member cannot change it before taking it
    expect(await asUser(m2.id, async (q) => (await q("update public.tasks set title = 'שונה' where id = $1", [t.id])).rowCount)).toBe(0);

    expect(await take(m2, t.id)).toEqual({ ok: true, owner_id: m2.id });
    const row = await asAdmin(async (q) => (await q<{ owner_id: string; team_id: string }>("select owner_id, team_id from public.tasks where id = $1", [t.id])).rows[0]);
    expect(row).toEqual({ owner_id: m2.id, team_id: team });
    expect(await sees(m2, t.id)).toBe(true);
    expect(await sees(m1, t.id)).toBe(true); // its creator
    expect(await sees(viewer, t.id)).toBe(false);
    // taking it again is fine for the taker, "taken" for anyone else
    expect(await take(m2, t.id)).toEqual({ ok: true, owner_id: m2.id });
    expect(await take(manager, t.id)).toEqual({ ok: false, reason: "taken" });
  });

  it("only the team's active writers, its manager and owners/admins may take it", async () => {
    const t = await teamTask(m1, "מי לוקח");
    for (const who of [viewer, m3, outsider]) expect((await pgError(take(who, t.id))).code, who.email).toBe("42501");
    expect(await take(admin, t.id)).toEqual({ ok: true, owner_id: admin.id });
  });

  it("two at once: exactly one wins", async () => {
    const t = await teamTask(manager, "מרוץ");
    const [first, second] = await Promise.all([
      asUser(m1.id, async (q) => {
        const r = (await q<{ r: Record<string, unknown> }>("select public.take_task($1, $2) as r", [org, t.id])).rows[0].r;
        // hold the row lock a moment, so the other call reads the task as free and then has to wait
        await q("select pg_sleep(0.3)");
        return r;
      }),
      asUser(m2.id, async (q) => {
        await q("select pg_sleep(0.1)");
        return (await q<{ r: Record<string, unknown> }>("select public.take_task($1, $2) as r", [org, t.id])).rows[0].r;
      }),
    ]);
    expect(first).toEqual({ ok: true, owner_id: m1.id });
    expect(second).toEqual({ ok: false, reason: "taken" });
    expect(await asAdmin(async (q) => (await q<{ owner_id: string }>("select owner_id from public.tasks where id = $1", [t.id])).rows[0].owner_id)).toBe(m1.id);
  });

  it("a closed task cannot be taken; a lead's call-back task is taken through its lead", async () => {
    const done = await teamTask(m1, "נסגרה");
    await asAdmin((q) => q("update public.tasks set status = 'done' where id = $1", [done.id]));
    expect(await take(m2, done.id)).toEqual({ ok: false, reason: "closed" });
    const call = await teamTask(m1, "שיחה חוזרת");
    await asAdmin((q) => q("insert into app.intake_callback_tasks (task_id, organization_id, lead_id) values ($1, $2, gen_random_uuid())", [call.id, org]));
    // ...and it is not shown to the team as a team task: it follows its lead (its title names the person)
    expect(await sees(m2, call.id)).toBe(false);
    expect(await sees(m1, call.id)).toBe(true); // its creator
    expect(await take(m2, call.id)).toEqual({ ok: false, reason: "lead" });
  });

  it("the app's rule for the 'לקחתי' button equals the database's, for every role and down a chain of teams", async () => {
    const { teamsForTaskRights } = await import("@/features/tasks/team-rights");
    // eleven teams under the team the manager manages, one under the other
    await asUser(owner.id, async (q) => {
      let parent = team;
      for (let i = 0; i < 11; i += 1) {
        parent = (await q<{ id: string }>("insert into public.teams (organization_id, name, parent_team_id) values ($1, $2, $3) returning id", [org, `שרשרת ${i}`, parent])).rows[0].id;
      }
    });
    const teams = await asAdmin(async (q) =>
      (await q<{ id: string; parent_team_id: string | null }>("select id, parent_team_id from public.teams where organization_id = $1", [org])).rows.map((t) => ({ id: t.id, parentId: t.parent_team_id })),
    );
    for (const [who, role] of [[owner, "owner"], [admin, "admin"], [manager, "manager"], [m1, "member"], [m2, "member"], [m3, "member"], [viewer, "viewer"]] as const) {
      const memberships = await asAdmin(async (q) =>
        (await q<{ team_id: string; is_manager: boolean }>("select team_id, is_manager from public.team_members where organization_id = $1 and user_id = $2", [org, who.id])).rows.map((m) => ({ teamId: m.team_id, isManager: m.is_manager })),
      );
      const app = teamsForTaskRights(role, teams, memberships);
      const db = await asUser(who.id, async (q) =>
        (await q<{ id: string; ok: boolean }>("select t.id, app.may_assign_team_task($1, t.id) as ok from public.teams t where t.organization_id = $1", [org])).rows,
      );
      for (const row of db) expect(app.has(row.id), `${role} ${who.email} ${row.id}`).toBe(row.ok);
    }
  });

  it("notices: the team's full-seat writers but the creator, once; taking it tells nobody else", async () => {
    const t = await teamTask(m1, "הודעות");
    const told = (await noticesOf(t.id)).map((n) => [n.user_id, n.type]);
    expect(told).toEqual([[manager.id, "assigned"], [m2.id, "assigned"]].sort((a, b) => a[0].localeCompare(b[0])));
    await take(m2, t.id);
    expect((await noticesOf(t.id)).length).toBe(told.length);
    // made by a server path (no person), as the intake's call-back tasks: no team notice
    const server = await asAdmin(async (q) => (await q<{ id: string }>("insert into public.tasks (organization_id, title, team_id) values ($1, 'מהשרת', $2) returning id", [org, other])).rows[0].id);
    expect(await noticesOf(server)).toEqual([]);
  });
});
