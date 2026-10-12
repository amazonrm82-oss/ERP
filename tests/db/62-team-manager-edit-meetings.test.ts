import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string };

// rows changed by one insert / update / delete ... returning
const affected = async (q: Query, sql: string, params: unknown[]) =>
  Number((await q<{ n: string }>(`with t as (${sql}) select count(*) as n from t`, params)).rows[0].n);

/**
 * CAL-01 (owner's answer, 12 October 2026): a team manager edits and cancels the
 * meetings organized by the people of their team, like their leads, and may
 * delete one (deleting is for admins and team managers, as for records). The
 * term is app.manages_meeting_organizer (0093): the manager role plus managing
 * the organizer's team or a parent team, under any visibility. A manager of
 * another team, a manager without a team, a plain teammate and a viewer gain
 * nothing. Who may change the organizer stays as it was.
 */
describe("team managers edit and cancel their team's meetings (CAL-01)", () => {
  let owner: U, rep: U, mgr: U, parentMgr: U, otherMgr: U, teammate: U, viewer: U, managerOfNoTeam: U;
  let org: string;
  let teamA: string;

  const setVisibility = (v: "org" | "team" | "own") =>
    asUser(owner.id, (q) => q("update public.organizations set record_visibility = $2 where id = $1", [org, v]));

  // an internal meeting organized and created by rep
  const newMeeting = () =>
    asUser(rep.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.meetings (organization_id, title, starts_at, ends_at) values ($1, 'פגישת צוות', '2026-11-12T08:30:00Z', '2026-11-12T09:30:00Z') returning id",
          [org],
        )
      ).rows[0].id,
    );

  const edits = (user: U, id: string) =>
    asUser(user.id, (q) => affected(q, "update public.meetings set title = 'פגישה מעודכנת' where id = $1 returning id", [id]));
  const cancels = (user: U, id: string) =>
    asUser(user.id, (q) => affected(q, "update public.meetings set status = 'cancelled' where id = $1 returning id", [id]));
  const deletes = (user: U, id: string) => asUser(user.id, (q) => affected(q, "delete from public.meetings where id = $1 returning id", [id]));
  const addsParticipant = (user: U, id: string, who: U) =>
    asUser(user.id, (q) =>
      affected(q, "insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3) returning meeting_id", [org, id, who.id]),
    ).catch((error: { code?: string }) => {
      // refused by the insert policy
      if (error.code === "42501") return 0;
      throw error;
    });
  const removesParticipant = (user: U, id: string, who: U) =>
    asUser(user.id, (q) => affected(q, "delete from public.meeting_participants where meeting_id = $1 and user_id = $2 returning meeting_id", [id, who.id]));
  const exists = (id: string) => asAdmin((q) => count(q, "select 1 from public.meetings where id = $1", [id]));

  beforeAll(async () => {
    owner = await createUser("tme-owner");
    org = await createOrg(owner.id);
    rep = await addMember(org, owner.id, "member", "tme-rep");
    mgr = await addMember(org, owner.id, "manager", "tme-mgr");
    parentMgr = await addMember(org, owner.id, "manager", "tme-parent-mgr");
    otherMgr = await addMember(org, owner.id, "manager", "tme-other-mgr");
    teammate = await addMember(org, owner.id, "member", "tme-teammate");
    viewer = await addMember(org, owner.id, "viewer", "tme-viewer");
    managerOfNoTeam = await addMember(org, owner.id, "manager", "tme-no-team");

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
  });

  for (const visibility of ["org", "team", "own"] as const) {
    it(`under '${visibility}': the manager of the organizer's team or of a parent team edits, cancels and changes who takes part`, async () => {
      await setVisibility(visibility);
      for (const manager of [mgr, parentMgr]) {
        const id = await newMeeting();
        expect(await edits(manager, id)).toBe(1);
        expect(await cancels(manager, id)).toBe(1);
        expect(await addsParticipant(manager, id, teammate)).toBe(1);
        expect(await removesParticipant(manager, id, teammate)).toBe(1);
        const row = await asAdmin(
          async (q) => (await q<{ title: string; status: string }>("select title, status from public.meetings where id = $1", [id])).rows[0],
        );
        expect(row).toEqual({ title: "פגישה מעודכנת", status: "cancelled" });
      }
    });

    it(`under '${visibility}': nobody else gains edit, cancel or participant rights`, async () => {
      await setVisibility(visibility);
      const id = await newMeeting();
      await asUser(rep.id, (q) =>
        q("insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3)", [org, id, mgr.id]),
      );
      for (const user of [otherMgr, teammate, viewer, managerOfNoTeam]) {
        expect(await edits(user, id)).toBe(0);
        expect(await cancels(user, id)).toBe(0);
        expect(await addsParticipant(user, id, user)).toBe(0);
        expect(await removesParticipant(user, id, mgr)).toBe(0);
      }
      const row = await asAdmin(
        async (q) => (await q<{ title: string; status: string }>("select title, status from public.meetings where id = $1", [id])).rows[0],
      );
      expect(row).toEqual({ title: "פגישת צוות", status: "planned" });
    });

    it(`under '${visibility}': deleting is for the team's managers (and admins, the creator), not for others`, async () => {
      await setVisibility(visibility);
      const id = await newMeeting();
      for (const user of [otherMgr, teammate, viewer, managerOfNoTeam]) {
        expect(await deletes(user, id)).toBe(0);
      }
      expect(await exists(id)).toBe(1);
      expect(await deletes(mgr, id)).toBe(1);
      expect(await exists(id)).toBe(0);

      const second = await newMeeting();
      expect(await deletes(parentMgr, second)).toBe(1);
      const third = await newMeeting();
      expect(await deletes(owner, third)).toBe(1);
      const fourth = await newMeeting();
      expect(await deletes(rep, fourth)).toBe(1);
    });
  }

  it("a manager of a same-named team in another organization can neither edit nor delete", async () => {
    await setVisibility("own");
    const id = await newMeeting();
    const otherOwner = await createUser("tme-x-owner");
    const otherOrg = await createOrg(otherOwner.id);
    const outsider = await addMember(otherOrg, otherOwner.id, "manager", "tme-x-mgr");
    await asAdmin(async (q) => {
      const team = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'מכירות') returning id", [otherOrg])).rows[0].id;
      await q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true)", [otherOrg, team, outsider.id]);
    });
    await asUser(otherOwner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [otherOrg]));
    expect(await edits(outsider, id)).toBe(0);
    expect(await cancels(outsider, id)).toBe(0);
    expect(await deletes(outsider, id)).toBe(0);
    expect(await edits(otherOwner, id)).toBe(0);
    expect(await deletes(otherOwner, id)).toBe(0);
    expect(await exists(id)).toBe(1);
  });

  it("a member who manages the team without the manager role gains nothing", async () => {
    await setVisibility("own");
    const id = await newMeeting();
    await asAdmin((q) => q("update public.team_members set is_manager = true where team_id = $1 and user_id = $2", [teamA, teammate.id]));
    try {
      expect(await edits(teammate, id)).toBe(0);
      expect(await cancels(teammate, id)).toBe(0);
      expect(await deletes(teammate, id)).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.team_members set is_manager = false where team_id = $1 and user_id = $2", [teamA, teammate.id]));
    }
  });

  it("the manager of the team does not gain the right to change the organizer", async () => {
    await setVisibility("own");
    const id = await newMeeting();
    const err = await pgError(asUser(mgr.id, (q) => q("update public.meetings set owner_id = $2 where id = $1", [id, mgr.id])));
    expect(err.code).toBe("42501");
  });

  it("a read-only organization: the manager can neither edit nor delete", async () => {
    await setVisibility("own");
    const id = await newMeeting();
    const before = await asAdmin(
      async (q) => (await q<{ status: string }>("select status from public.organizations where id = $1", [org])).rows[0].status,
    );
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect(await edits(mgr, id)).toBe(0);
      expect(await deletes(mgr, id)).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = $2::public.org_status where id = $1", [org, before]));
    }
  });
});
