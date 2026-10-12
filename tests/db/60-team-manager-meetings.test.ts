import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead } from "./helpers";

afterAll(closePool);

type U = { id: string };
type Busy = { user_id: string; meeting_id: string | null; title: string | null };

/**
 * CAL-01 (owner's answer, 12 October 2026): a team manager sees the meetings
 * organized by the people of their team, internal ones included, like the rest
 * of the records. A manager of another team, a plain member of the same team
 * and a viewer do not. The rule is the manager branch of app.can_read_record,
 * so it holds under 'own' too, exactly as for the organizer's leads.
 * public.meeting_busy() gives the id and title exactly when the row is readable.
 */
describe("team managers see their team's meetings (CAL-01)", () => {
  let owner: U, rep: U, mgr: U, parentMgr: U, otherMgr: U, teammate: U, viewer: U, managerOfNoTeam: U;
  let org: string;
  let internal: string, lead: string;
  let teamA: string;

  const setVisibility = (v: "org" | "team" | "own") =>
    asUser(owner.id, (q) => q("update public.organizations set record_visibility = $2 where id = $1", [org, v]));
  const sees = (user: U, table: string, id: string) =>
    asUser(user.id, (q) => count(q, `select 1 from public.${table} where id = $1`, [id]));
  const busy = (caller: U, users: string[]) =>
    asUser(caller.id, async (q) =>
      (
        await q<Busy>("select user_id, meeting_id, title from public.meeting_busy($1, $2::uuid[], $3, $4)", [
          org,
          users,
          "2026-11-10T08:00:00Z",
          "2026-11-10T10:00:00Z",
        ])
      ).rows,
    );

  beforeAll(async () => {
    owner = await createUser("tmm-owner");
    org = await createOrg(owner.id);
    rep = await addMember(org, owner.id, "member", "tmm-rep");
    mgr = await addMember(org, owner.id, "manager", "tmm-mgr");
    parentMgr = await addMember(org, owner.id, "manager", "tmm-parent-mgr");
    otherMgr = await addMember(org, owner.id, "manager", "tmm-other-mgr");
    teammate = await addMember(org, owner.id, "member", "tmm-teammate");
    viewer = await addMember(org, owner.id, "viewer", "tmm-viewer");
    managerOfNoTeam = await addMember(org, owner.id, "manager", "tmm-no-team");

    await asAdmin(async (q) => {
      const team = async (name: string, parent: string | null = null) =>
        (
          await q<{ id: string }>("insert into public.teams (organization_id, name, parent_team_id) values ($1, $2, $3) returning id", [
            org,
            name,
            parent,
          ])
        ).rows[0].id;
      const parent = await team("אזור");
      teamA = await team("מכירות", parent);
      const teamB = await team("שירות");
      await q(
        `insert into public.team_members (organization_id, team_id, user_id, is_manager) values
           ($1, $2, $5, false), ($1, $2, $6, true), ($1, $2, $7, false), ($1, $2, $10, false),
           ($1, $3, $8, true), ($1, $4, $9, true)`,
        [org, teamA, parent, teamB, rep.id, mgr.id, teammate.id, parentMgr.id, otherMgr.id, viewer.id],
      );
    });

    // an internal meeting organized (and created) by rep, no participants
    internal = await asUser(rep.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.meetings (organization_id, title, starts_at, ends_at) values ($1, 'פגישת צוות', '2026-11-10T08:30:00Z', '2026-11-10T09:30:00Z') returning id",
          [org],
        )
      ).rows[0].id,
    );
    lead = await insertLead(rep.id, org);
  });

  for (const visibility of ["team", "own"] as const) {
    it(`under '${visibility}': the manager of the organizer's team (or of a parent team) sees the internal meeting; no one else new does`, async () => {
      await setVisibility(visibility);
      expect(await sees(mgr, "meetings", internal)).toBe(1);
      expect(await sees(parentMgr, "meetings", internal)).toBe(1);
      expect(await sees(owner, "meetings", internal)).toBe(1);
      expect(await sees(rep, "meetings", internal)).toBe(1);
      for (const user of [otherMgr, teammate, viewer, managerOfNoTeam]) {
        expect(await sees(user, "meetings", internal)).toBe(0);
      }
      // the same managers as for a lead of the organizer (the record rule it mirrors);
      // plain teammates (member or viewer) under 'team': records yes, meetings no
      for (const user of [mgr, parentMgr, otherMgr, managerOfNoTeam]) {
        expect(await sees(user, "meetings", internal)).toBe(await sees(user, "leads", lead));
      }
      for (const user of [teammate, viewer]) {
        expect(await sees(user, "leads", lead)).toBe(visibility === "team" ? 1 : 0);
      }
    });
  }

  it("a team manager also sees who takes part, and a participant still sees the meeting", async () => {
    await setVisibility("own");
    await asUser(rep.id, (q) =>
      q("insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3)", [org, internal, teammate.id]),
    );
    expect(await asUser(mgr.id, (q) => count(q, "select 1 from public.meeting_participants where meeting_id = $1", [internal]))).toBe(1);
    expect(await asUser(otherMgr.id, (q) => count(q, "select 1 from public.meeting_participants where meeting_id = $1", [internal]))).toBe(0);
    expect(await sees(teammate, "meetings", internal)).toBe(1);
    await asUser(rep.id, (q) => q("delete from public.meeting_participants where meeting_id = $1 and user_id = $2", [internal, teammate.id]));
    expect(await sees(teammate, "meetings", internal)).toBe(0);
  });

  it("a manager role without managing the team, or managing it without the manager role, does not see it", async () => {
    await setVisibility("own");
    // teammate becomes a team manager (is_manager) but keeps the member role
    await asAdmin((q) => q("update public.team_members set is_manager = true where team_id = $1 and user_id = $2", [teamA, teammate.id]));
    try {
      expect(await sees(teammate, "meetings", internal)).toBe(0);
      expect(await sees(teammate, "leads", lead)).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.team_members set is_manager = false where team_id = $1 and user_id = $2", [teamA, teammate.id]));
    }
  });

  it("an organizer in several teams counts in their primary team only, like their records", async () => {
    await setVisibility("own");
    const teamB = await asAdmin(async (q) =>
      (await q<{ team_id: string }>("select team_id from public.team_members where organization_id = $1 and user_id = $2", [org, otherMgr.id]))
        .rows[0].team_id,
    );
    await asAdmin((q) => q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [org, teamB, rep.id]));
    try {
      // two teams, none primary: no team, so neither manager sees it (a new lead would get no team either)
      expect(await sees(mgr, "meetings", internal)).toBe(0);
      expect(await sees(otherMgr, "meetings", internal)).toBe(0);
      await asAdmin((q) => q("update public.team_members set is_primary = true where team_id = $1 and user_id = $2", [teamB, rep.id]));
      expect(await sees(mgr, "meetings", internal)).toBe(0);
      expect(await sees(otherMgr, "meetings", internal)).toBe(1);
    } finally {
      await asAdmin((q) => q("update public.team_members set is_primary = false where team_id = $1 and user_id = $2", [teamB, rep.id]));
      await asAdmin((q) => q("delete from public.team_members where team_id = $1 and user_id = $2", [teamB, rep.id]));
    }
    expect(await sees(mgr, "meetings", internal)).toBe(1);
  });

  for (const visibility of ["team", "own"] as const) {
    it(`under '${visibility}': meeting_busy returns the id and title exactly when the caller may select the meeting`, async () => {
      await setVisibility(visibility);
      for (const caller of [owner, rep, mgr, parentMgr, otherMgr, teammate, managerOfNoTeam]) {
        const rows = await busy(caller, [rep.id]);
        expect(rows).toHaveLength(1);
        const readable = (await sees(caller, "meetings", internal)) === 1;
        expect(rows[0]).toEqual(
          readable
            ? { user_id: rep.id, meeting_id: internal, title: "פגישת צוות" }
            : { user_id: rep.id, meeting_id: null, title: null },
        );
      }
      expect((await busy(mgr, [rep.id]))[0].meeting_id).toBe(internal);
      expect((await busy(otherMgr, [rep.id]))[0].meeting_id).toBeNull();
    });
  }

  it("the helper is security definer with a pinned search path, not executable by anon", async () => {
    const fn = await asAdmin(async (q) =>
      (
        await q<{ secdef: boolean; config: string[] | null; anon: boolean; auth: boolean }>(`
          select p.prosecdef as secdef, p.proconfig as config,
                 has_function_privilege('anon', p.oid, 'execute') as anon,
                 has_function_privilege('authenticated', p.oid, 'execute') as auth
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'app' and p.proname = 'manages_meeting_organizer'`)
      ).rows,
    );
    expect(fn).toHaveLength(1);
    expect(fn[0]).toMatchObject({ secdef: true, anon: false, auth: true });
    expect(fn[0].config).toContain('search_path=""');
  });
});
