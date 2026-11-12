import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Form = { owner_id: string | null; team_id: string | null; assign_mode: string };

/**
 * BIZ-01, the owner's answer (314) ב of 12 November 2026 (migration 021239): owners and admins choose who gets the leads of
 * the business page's form: the regular distribution (default), one active non-viewer member, or one team. The choice is
 * kept on the page's own form (owner_id / team_id / assign_mode), which intake_submit honours as for any form; a chosen
 * person who leaves, is suspended or becomes a viewer falls back to the regular distribution.
 */
describe("business page: who gets the leads (314) ב", () => {
  let owner: U, admin: U, member: U, teamRep: U, viewer: U, leaver: U, outsider: U;
  let org: string, team: string, otherTeam: string;
  let page: { id: string; token: string };
  let seq = 0;
  const hash = () => `bpr-${process.pid}-${++seq}`.padStart(64, "0");
  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];

  const form = () =>
    asAdmin((q) => one<Form>(q, "select owner_id, team_id, assign_mode from public.forms where organization_id = $1 and business_page_id = $2", [org, page.id]));
  const routing = () =>
    asAdmin((q) => one<{ owner_user_id: string | null; team_id: string | null }>(q, "select owner_user_id, team_id from public.business_pages where id = $1", [page.id]));
  const set = (u: U, ownerId: string | null, teamId: string | null) =>
    asUser(u.id, async (q) => (await q("update public.business_pages set owner_user_id = $2, team_id = $3 where id = $1", [page.id, ownerId, teamId])).rowCount);
  const submit = async (phone: string) => {
    const reply = await asService(async (q) =>
      (await one<{ r: Record<string, unknown> }>(q, "select public.business_page_submit($1, $2, $3, 'test', false) as r", [page.token, JSON.stringify({ full_name: "פונה", phone }), hash()])).r,
    );
    expect(reply).toEqual({ status: "accepted" });
    return asAdmin((q) =>
      one<{ owner_id: string | null; team_id: string | null }>(q, "select owner_id, team_id from public.leads where organization_id = $1 and phone = $2", [org, phone]),
    );
  };

  beforeAll(async () => {
    owner = await createUser("bpr-owner");
    org = await createOrg(owner.id, "עסק החלוקה");
    admin = await addMember(org, owner.id, "admin", "bpr-admin");
    member = await addMember(org, owner.id, "member", "bpr-member");
    teamRep = await addMember(org, owner.id, "member", "bpr-team");
    viewer = await addMember(org, owner.id, "viewer", "bpr-viewer");
    leaver = await addMember(org, owner.id, "member", "bpr-leaver");
    outsider = await createUser("bpr-outsider");
    const otherOrg = await createOrg(outsider.id, "עסק זר");
    team = await asAdmin(async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.teams (organization_id, name) values ($1, 'צוות מכירות') returning id", [org])).id;
      await q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [org, id, teamRep.id]);
      return id;
    });
    otherTeam = await asAdmin(async (q) => (await one<{ id: string }>(q, "insert into public.teams (organization_id, name) values ($1, 'זר') returning id", [otherOrg])).id);
    page = await asUser(owner.id, (q) =>
      one<{ id: string; token: string }>(q, "insert into public.business_pages (organization_id, is_active, about) values ($1, true, 'דף') returning id, token", [org]),
    );
  });

  it("by default the page's form uses the business's regular distribution", async () => {
    expect(await routing()).toEqual({ owner_user_id: null, team_id: null });
    expect(await form()).toEqual({ owner_id: null, team_id: null, assign_mode: "round_robin" });
  });

  it("one person: the form names them, and a new inquiry is theirs", async () => {
    expect(await set(admin, member.id, null)).toBe(1);
    expect(await form()).toEqual({ owner_id: member.id, team_id: null, assign_mode: "owner" });
    expect(await submit("050-7001001")).toEqual({ owner_id: member.id, team_id: null });
    // back to the regular distribution
    expect(await set(owner, null, null)).toBe(1);
    expect(await form()).toEqual({ owner_id: null, team_id: null, assign_mode: "round_robin" });
  });

  it("one team: the distribution among its members", async () => {
    expect(await set(owner, null, team)).toBe(1);
    expect(await form()).toEqual({ owner_id: null, team_id: team, assign_mode: "round_robin" });
    expect(await submit("050-7001002")).toEqual({ owner_id: teamRep.id, team_id: team });
    // a team removed: back to the regular distribution
    await asAdmin((q) => q("delete from public.teams where id = $1", [team]));
    expect(await routing()).toEqual({ owner_user_id: null, team_id: null });
    expect(await form()).toEqual({ owner_id: null, team_id: null, assign_mode: "round_robin" });
  });

  it("refuses both at once, a viewer, an outsider, another business's team, and anyone but owners and admins", async () => {
    expect((await pgError(set(owner, member.id, otherTeam))).hint).toBe("business_page:routing");
    expect((await pgError(set(owner, viewer.id, null))).hint).toBe("business_page:owner");
    expect((await pgError(set(owner, outsider.id, null))).hint).toBe("business_page:owner");
    expect((await pgError(set(owner, null, otherTeam))).code).toBe("23503");
    for (const u of [member, viewer, outsider]) expect(await set(u, member.id, null)).toBe(0);
    expect(await routing()).toEqual({ owner_user_id: null, team_id: null });
  });

  it("a chosen person who is suspended, becomes a viewer or leaves: back to the regular distribution", async () => {
    const membership = (u: U, sets: string) =>
      asAdmin((q) => q(`update public.memberships set ${sets} where organization_id = $1 and user_id = $2`, [org, u.id]));
    // suspended
    expect(await set(owner, leaver.id, null)).toBe(1);
    await membership(leaver, "status = 'suspended'");
    expect(await routing()).toEqual({ owner_user_id: null, team_id: null });
    expect(await form()).toEqual({ owner_id: null, team_id: null, assign_mode: "round_robin" });
    await membership(leaver, "status = 'active'");
    // becomes a viewer
    expect(await set(owner, leaver.id, null)).toBe(1);
    await membership(leaver, "role = 'viewer', seat_type = 'view'");
    expect(await routing()).toEqual({ owner_user_id: null, team_id: null });
    expect(await form()).toEqual({ owner_id: null, team_id: null, assign_mode: "round_robin" });
    await membership(leaver, "role = 'member', seat_type = 'full'");
    // leaves (the membership is removed)
    expect(await set(owner, leaver.id, null)).toBe(1);
    await asAdmin((q) => q("delete from public.memberships where organization_id = $1 and user_id = $2", [org, leaver.id]));
    expect(await routing()).toEqual({ owner_user_id: null, team_id: null });
    expect(await form()).toEqual({ owner_id: null, team_id: null, assign_mode: "round_robin" });
    // someone else's change of status leaves the page alone
    expect(await set(owner, member.id, null)).toBe(1);
    await membership(teamRep, "status = 'suspended'");
    expect(await routing()).toEqual({ owner_user_id: member.id, team_id: null });
    await membership(teamRep, "status = 'active'");
  });

  it("a person on the page's form can be changed only through the page", async () => {
    expect((await pgError(asUser(owner.id, (q) => q("update public.forms set owner_id = null where business_page_id = $1", [page.id])))).hint).toBe("form:page");
  });
});
