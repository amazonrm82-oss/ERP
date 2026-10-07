import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, createOrg, createUser, insertLead } from "./helpers";

afterAll(closePool);

type U = { id: string };

describe("a record joins its owner's team", () => {
  let owner: U, manager: U, rep: U, twoTeams: U, loner: U;
  let org: string, sales: string, support: string;

  beforeAll(async () => {
    owner = await createUser("team-owner");
    org = await createOrg(owner.id);
    manager = await addMember(org, owner.id, "manager");
    rep = await addMember(org, owner.id, "member");
    twoTeams = await addMember(org, owner.id, "member");
    loner = await addMember(org, owner.id, "member");
    [sales, support] = await asAdmin(async (q) => {
      const a = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'מכירות') returning id", [org])).rows[0].id;
      const b = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'שירות') returning id", [org])).rows[0].id;
      await q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true), ($1, $2, $4, false), ($1, $2, $5, false), ($1, $6, $5, false)", [org, a, manager.id, rep.id, twoTeams.id, b]);
      return [a, b];
    });
  });

  const teamOf = (id: string) => asAdmin(async (q) => (await q<{ team_id: string | null }>("select team_id from public.leads where id = $1", [id])).rows[0].team_id);

  it("a new record gets the owner's only team; none when the owner has two or none", async () => {
    expect(await teamOf(await insertLead(rep.id, org))).toBe(sales);
    expect(await teamOf(await insertLead(twoTeams.id, org))).toBeNull();
    expect(await teamOf(await insertLead(loner.id, org))).toBeNull();
    // a team chosen on purpose is kept
    expect(await teamOf(await insertLead(owner.id, org, { owner_id: twoTeams.id, team_id: support }))).toBe(support);
  });

  it("a team manager can create a record for someone in the team without picking a team", async () => {
    const id = await insertLead(manager.id, org, { owner_id: rep.id });
    expect(await teamOf(id)).toBe(sales);
  });

  it("a new owner brings their team, unless a team is set in the same change", async () => {
    const id = await insertLead(loner.id, org);
    await asUser(owner.id, (q) => q("update public.leads set owner_id = $1 where id = $2", [rep.id, id]));
    expect(await teamOf(id)).toBe(sales);
    await asUser(owner.id, (q) => q("update public.leads set owner_id = $1, team_id = $2 where id = $3", [twoTeams.id, support, id]));
    expect(await teamOf(id)).toBe(support);
  });
});
