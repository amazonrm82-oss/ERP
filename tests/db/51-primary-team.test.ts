import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMember,
  asAdmin,
  asAnon,
  asUser,
  closePool,
  count,
  createOrg,
  createUser,
  defaultPipeline,
  insertLead,
  pgError,
} from "./helpers";

afterAll(closePool);

type U = { id: string };

// CAP-06: a user in several teams has one primary team; their new records join it.
describe("primary team", () => {
  let owner: U, admin: U, manager: U, multi: U, single: U, outsider: U;
  let org: string, otherOrg: string, sales: string, support: string, field: string;

  const primaryOf = (userId: string, orgId = org) =>
    asAdmin(async (q) =>
      (
        await q<{ team_id: string }>(
          "select team_id from public.team_members where organization_id = $1 and user_id = $2 and is_primary",
          [orgId, userId],
        )
      ).rows.map((row) => row.team_id),
    );
  const teamOf = (table: string, id: string) =>
    asAdmin(async (q) => (await q<{ team_id: string | null }>(`select team_id from public.${table} where id = $1`, [id])).rows[0].team_id);
  const setPrimary = (as: string, team: string, user: string, primary = true, orgId = org) =>
    asUser(as, (q) => q("select public.set_primary_team($1, $2, $3, $4)", [orgId, team, user, primary]));

  beforeAll(async () => {
    owner = await createUser("primary-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin");
    manager = await addMember(org, owner.id, "manager");
    multi = await addMember(org, owner.id, "member");
    single = await addMember(org, owner.id, "member");
    outsider = await createUser("primary-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    [sales, support, field] = await asAdmin(async (q) => {
      const ids: string[] = [];
      for (const name of ["מכירות", "שירות", "שטח"]) {
        ids.push((await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, $2) returning id", [org, name])).rows[0].id);
      }
      const [a, b, c] = ids;
      await q(
        `insert into public.team_members (organization_id, team_id, user_id, is_manager) values
           ($1, $2, $5, true), ($1, $2, $6, false), ($1, $3, $6, false), ($1, $4, $6, false), ($1, $2, $7, false)`,
        [org, a, b, c, manager.id, multi.id, single.id],
      );
      return ids;
    });
  });

  it("starts with no primary team, and a user in several teams gets no team", async () => {
    expect(await primaryOf(multi.id)).toEqual([]);
    expect(await teamOf("leads", await insertLead(multi.id, org))).toBeNull();
    // a user in exactly one team gets it without any flag
    expect(await teamOf("leads", await insertLead(single.id, org))).toBe(sales);
  });

  it("an admin sets the primary team; the user and every member can see it", async () => {
    await setPrimary(admin.id, support, multi.id);
    expect(await primaryOf(multi.id)).toEqual([support]);
    for (const reader of [multi, single, manager]) {
      const seen = await asUser(reader.id, async (q) =>
        (await q<{ team_id: string }>("select team_id from public.team_members where organization_id = $1 and user_id = $2 and is_primary", [org, multi.id])).rows,
      );
      expect(seen.map((row) => row.team_id)).toEqual([support]);
    }
    // audited like any other change of team membership
    const audited = await asAdmin((q) =>
      count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type = 'team_members' and action = 'update' and changes ? 'is_primary'", [org]),
    );
    expect(audited).toBeGreaterThan(0);
  });

  it("new records of the user join the primary team: leads, contacts, companies, deals and tasks", async () => {
    expect(await teamOf("leads", await insertLead(multi.id, org))).toBe(support);
    const { pipelineId, stages } = await defaultPipeline(org);
    const ids = await asUser(multi.id, async (q) => ({
      contacts: (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'דנה') returning id", [org])).rows[0].id,
      companies: (await q<{ id: string }>("insert into public.companies (organization_id, name) values ($1, 'חברה') returning id", [org])).rows[0].id,
      deals: (
        await q<{ id: string }>(
          "insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה', $2, $3) returning id",
          [org, pipelineId, stages[0].id],
        )
      ).rows[0].id,
      tasks: (await q<{ id: string }>("insert into public.tasks (organization_id, title) values ($1, 'משימה') returning id", [org])).rows[0].id,
    }));
    for (const [table, id] of Object.entries(ids)) {
      expect(await teamOf(table, id), table).toBe(support);
    }
  });

  it("a record created for the user by someone else joins the user's primary team; a chosen team is kept", async () => {
    expect(await teamOf("leads", await insertLead(admin.id, org, { owner_id: multi.id }))).toBe(support);
    expect(await teamOf("leads", await insertLead(admin.id, org, { owner_id: multi.id, team_id: field }))).toBe(field);
  });

  it("handing a record to the user brings the primary team", async () => {
    const id = await insertLead(owner.id, org);
    expect(await teamOf("leads", id)).toBeNull();
    await asUser(owner.id, (q) => q("update public.leads set owner_id = $1 where id = $2", [multi.id, id]));
    expect(await teamOf("leads", id)).toBe(support);
  });

  it("moving the primary team clears the old one in the same step", async () => {
    await setPrimary(admin.id, field, multi.id);
    expect(await primaryOf(multi.id)).toEqual([field]);
    expect(await teamOf("leads", await insertLead(multi.id, org))).toBe(field);
    // unmarking leaves no primary team
    await setPrimary(owner.id, field, multi.id, false);
    expect(await primaryOf(multi.id)).toEqual([]);
    expect(await teamOf("leads", await insertLead(multi.id, org))).toBeNull();
    await setPrimary(owner.id, sales, multi.id);
  });

  it("a user has at most one primary team per organization", async () => {
    const error = await pgError(
      asUser(admin.id, (q) =>
        q("update public.team_members set is_primary = true where organization_id = $1 and user_id = $2 and team_id = $3", [org, multi.id, support]),
      ),
    );
    expect(error.code).toBe("23505");
    expect(await primaryOf(multi.id)).toEqual([sales]);
  });

  it("only admins set it: members, managers and the user themselves are refused, nothing changes", async () => {
    for (const who of [multi, manager, single]) {
      const error = await pgError(setPrimary(who.id, support, multi.id));
      expect(error.code, who.id).toBe("P0002");
      expect((await asUser(who.id, (q) => q("update public.team_members set is_primary = false where user_id = $1", [multi.id]))).rowCount).toBe(0);
    }
    expect(await primaryOf(multi.id)).toEqual([sales]);
  });

  it("a team the user is not in cannot be primary, and the failed call keeps the old primary", async () => {
    expect((await pgError(setPrimary(admin.id, support, single.id))).code).toBe("P0002");
    expect((await pgError(setPrimary(admin.id, support, outsider.id))).code).toBe("P0002");
    expect(await primaryOf(multi.id)).toEqual([sales]);
    expect(await primaryOf(single.id)).toEqual([]);
  });

  it("another organization's admin can neither read nor set it", async () => {
    expect((await pgError(setPrimary(outsider.id, support, multi.id))).code).toBe("P0002");
    expect((await pgError(setPrimary(outsider.id, support, multi.id, true, otherOrg))).code).toBe("P0002");
    await asUser(outsider.id, async (q) => {
      expect(await count(q, "select 1 from public.team_members where organization_id = $1", [org])).toBe(0);
      expect((await q("update public.team_members set is_primary = false")).rowCount).toBe(0);
    });
    expect(await primaryOf(multi.id)).toEqual([sales]);
  });

  it("anonymous callers cannot run the function", async () => {
    const error = await pgError(asAnon((q) => q("select public.set_primary_team($1, $2, $3, true)", [org, support, multi.id])));
    expect(error.code).toBe("42501");
  });

  it("a read-only organization cannot change it", async () => {
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect((await pgError(setPrimary(owner.id, field, multi.id))).code).toBe("P0002");
      expect(await primaryOf(multi.id)).toEqual([sales]);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
  });

  it("leaving the primary team drops the flag with the membership", async () => {
    await asUser(admin.id, (q) => q("delete from public.team_members where team_id = $1 and user_id = $2", [sales, multi.id]));
    expect(await primaryOf(multi.id)).toEqual([]);
    // still in two teams, none primary: no team
    expect(await teamOf("leads", await insertLead(multi.id, org))).toBeNull();
    // down to one team: that one, as before
    await asUser(admin.id, (q) => q("delete from public.team_members where team_id = $1 and user_id = $2", [field, multi.id]));
    expect(await teamOf("leads", await insertLead(multi.id, org))).toBe(support);
  });
});
