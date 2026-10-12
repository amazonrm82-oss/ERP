import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

// REC-01 (owner's decision, 12 October 2026): a team manager may pin and unpin what the people
// of their team logged on the team's records, but not edit what it says or delete it.
describe("team managers pin their team's notes (REC-01)", () => {
  let owner: U, managerA: U, memberA: U, colleagueA: U, managerB: U, memberB: U, parentManager: U, stranger: U;
  let org: string, otherOrg: string, teamA: string, teamB: string;
  let leadA: string, leadB: string, strangerLead: string;

  beforeAll(async () => {
    owner = await createUser("pin-owner");
    org = await createOrg(owner.id);
    managerA = await addMember(org, owner.id, "manager", "pin-manager-a");
    memberA = await addMember(org, owner.id, "member", "pin-member-a");
    colleagueA = await addMember(org, owner.id, "member", "pin-colleague-a");
    managerB = await addMember(org, owner.id, "manager", "pin-manager-b");
    memberB = await addMember(org, owner.id, "member", "pin-member-b");
    parentManager = await addMember(org, owner.id, "manager", "pin-parent-manager");
    stranger = await createUser("pin-stranger");
    otherOrg = await createOrg(stranger.id, "עסק אחר");

    [teamA, teamB] = await asUser(owner.id, async (q) => {
      const parent = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'אזור') returning id", [org])).rows[0].id;
      const a = (await q<{ id: string }>("insert into public.teams (organization_id, name, parent_team_id) values ($1, 'צוות א', $2) returning id", [org, parent])).rows[0].id;
      const b = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'צוות ב') returning id", [org])).rows[0].id;
      await q(
        `insert into public.team_members (organization_id, team_id, user_id, is_manager) values
           ($1, $2, $4, true), ($1, $2, $5, false), ($1, $2, $6, false),
           ($1, $3, $7, true), ($1, $3, $8, false), ($1, $9, $10, true)`,
        [org, a, b, managerA.id, memberA.id, colleagueA.id, managerB.id, memberB.id, parent, parentManager.id],
      );
      return [a, b];
    });
    // visibility 'org' (the default): everyone sees both leads, so a refusal is not just "cannot see it"
    leadA = await insertLead(memberA.id, org, { full_name: "ליד של צוות א", team_id: teamA });
    leadB = await insertLead(memberB.id, org, { full_name: "ליד של צוות ב", team_id: teamB });
    strangerLead = await insertLead(stranger.id, otherOrg);
  });

  const note = (user: U, lead: string, body = "הערה", type = "note") =>
    asUser(user.id, async (q) =>
      (await q<{ id: string }>("insert into public.activities (organization_id, type, body, lead_id) values ($1, $2, $3, $4) returning id", [org, type, body, lead])).rows[0].id,
    );
  const oldNote = (user: U, lead: string, hours: number) =>
    asAdmin(async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.activities (organization_id, type, body, lead_id, created_by, created_at) values ($1, 'note', 'ישנה', $2, $3, now() - make_interval(hours => $4)) returning id",
          [org, lead, user.id, hours],
        )
      ).rows[0].id,
    );
  const pin = (user: U, id: string, value = true) =>
    asUser(user.id, async (q) => (await q("update public.activities set is_pinned = $1 where id = $2", [value, id])).rowCount);
  const pinned = (id: string) => asAdmin(async (q) => (await q<{ p: boolean }>("select is_pinned as p from public.activities where id = $1", [id])).rows[0].p);
  const bodyOf = (id: string) => asAdmin(async (q) => (await q<{ body: string }>("select body from public.activities where id = $1", [id])).rows[0]?.body);
  const exists = (id: string) => asAdmin((q) => count(q, "select 1 from public.activities where id = $1", [id]));

  it("the manager pins and unpins a team member's note on a team record, fresh or old", async () => {
    for (const id of [await note(memberA, leadA, "של חבר צוות"), await oldNote(memberA, leadA, 24 * 30)]) {
      expect(await pin(managerA, id, true)).toBe(1);
      expect(await pinned(id)).toBe(true);
      expect(await pin(managerA, id, false)).toBe(1);
      expect(await pinned(id)).toBe(false);
    }
    // every kind a person logs, not only notes
    const call = await note(memberA, leadA, "שיחה", "call");
    expect(await pin(managerA, call)).toBe(1);
  });

  it("a manager of a parent team pins too, as for the records themselves", async () => {
    const id = await note(colleagueA, leadA);
    expect(await pin(parentManager, id)).toBe(1);
    expect(await pinned(id)).toBe(true);
  });

  it("the manager cannot change what it says, at any age, nor delete it", async () => {
    const id = await note(memberA, leadA, "מקור");
    for (const change of ["body = 'נערך'", "occurred_at = now()", "metadata = '{\"x\": 1}'::jsonb", "body = 'נערך', is_pinned = true"]) {
      const error = await pgError(asUser(managerA.id, (q) => q(`update public.activities set ${change} where id = $1`, [id])));
      expect(error.code, change).toBe("42501");
      expect(error.hint, change).toBe("note:pin_only");
    }
    expect(await bodyOf(id)).toBe("מקור");
    expect(await pinned(id)).toBe(false);
    expect(await asUser(managerA.id, async (q) => (await q("delete from public.activities where id = $1", [id])).rowCount)).toBe(0);
    expect(await exists(id)).toBe(1);
    // the author still edits within 24 hours
    expect(await asUser(memberA.id, async (q) => (await q("update public.activities set body = 'תוקן' where id = $1", [id])).rowCount)).toBe(1);
  });

  it("a system event is not pinned by a manager", async () => {
    const id = await note(memberA, leadA, "", "status_change");
    expect(await pin(managerA, id)).toBe(0);
  });

  it("a manager of another team cannot pin it, nor can a team member pin a colleague's note", async () => {
    const id = await note(memberA, leadA);
    for (const who of [managerB, colleagueA, memberB]) {
      expect(await asUser(who.id, (q) => count(q, "select 1 from public.activities where id = $1", [id]))).toBe(1);
      expect(await pin(who, id)).toBe(0);
    }
    expect(await pinned(id)).toBe(false);
  });

  it("another organization cannot pin it, not even its owner", async () => {
    const id = await note(memberA, leadA);
    expect(await pin(stranger, id)).toBe(0);
    expect(await pinned(id)).toBe(false);
  });

  it("a manager who is read-only in the organization cannot pin", async () => {
    const id = await note(memberA, leadA);
    // the manager's own team no longer manages: they are demoted to viewer
    const viewerManager = await addMember(org, owner.id, "viewer", "pin-viewer-manager");
    await asUser(owner.id, (q) =>
      q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true)", [org, teamA, viewerManager.id]),
    );
    expect(await pin(viewerManager, id)).toBe(0);
  });

  it("an update with no WHERE clause by a manager reaches only their team's entries", async () => {
    const team = await note(memberA, leadA, "צוות א");
    const other = await note(memberB, leadB, "צוות ב");
    const strangers = await asUser(stranger.id, async (q) =>
      (await q<{ id: string }>("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'של זר', $2) returning id", [otherOrg, strangerLead])).rows[0].id,
    );
    await asUser(managerA.id, (q) => q("update public.activities set is_pinned = false"));
    await asUser(managerA.id, (q) => q("update public.activities set is_pinned = true"));
    expect(await pinned(team)).toBe(true);
    expect(await pinned(other)).toBe(false);
    expect(await pinned(strangers)).toBe(false);

    // changing every text at once reaches the team's entries, so the whole statement is refused
    const refused = await pgError(asUser(managerA.id, (q) => q("update public.activities set body = 'HACKED'")));
    expect(refused.code).toBe("42501");
    for (const [id, body] of [[team, "צוות א"], [other, "צוות ב"], [strangers, "של זר"]]) {
      expect(await bodyOf(id)).toBe(body);
    }
    await asUser(managerA.id, async (q) => {
      await q("delete from public.activities");
    });
    expect(await exists(team)).toBe(1);
    expect(await exists(other)).toBe(1);
  });

  it("a team member's note on a record of another team stays out of the manager's reach", async () => {
    // the member of team A writes on team B's lead: the record decides, not the author
    const id = await note(memberA, leadB);
    expect(await pin(managerA, id)).toBe(0);
    expect(await pin(managerB, id)).toBe(1);
  });
});
