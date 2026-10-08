import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

describe("saved views shared with a team (LST-04)", () => {
  let owner: { id: string }, sales1: { id: string }, sales2: { id: string }, support: { id: string };
  let org: string, salesTeam: string, supportTeam: string;

  beforeAll(async () => {
    owner = await createUser("views-owner");
    org = await createOrg(owner.id);
    sales1 = await addMember(org, owner.id, "member", "sales1");
    sales2 = await addMember(org, owner.id, "member", "sales2");
    support = await addMember(org, owner.id, "member", "support");
    [salesTeam, supportTeam] = await asAdmin(async (q) => {
      const a = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'מכירות') returning id", [org])).rows[0].id;
      const b = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'שירות') returning id", [org])).rows[0].id;
      await q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3), ($1, $2, $4), ($1, $5, $6)", [org, a, sales1.id, sales2.id, b, support.id]);
      return [a, b];
    });
  });

  const share = (userId: string, team: string, name: string) =>
    asUser(userId, (q) =>
      q(
        `insert into public.saved_views (organization_id, object_type, name, scope, team_id, owner_id, config)
         values ($1, 'lead', $2, 'team', $3, $4, '{"filters": {}, "sort": "-created", "columns": [{"key": "phone", "width": "wide"}]}')`,
        [org, name, team, userId],
      ),
    );
  const visible = (userId: string, name: string) => asUser(userId, (q) => count(q, "select 1 from public.saved_views where name = $1", [name]));

  it("a member shares with their own team; the team sees it with its sort and columns, others do not", async () => {
    await share(sales1.id, salesTeam, "לידים חמים");
    expect(await visible(sales2.id, "לידים חמים")).toBe(1);
    expect(await visible(support.id, "לידים חמים")).toBe(0);
    const config = await asUser(sales2.id, async (q) => (await q<{ config: { sort: string } }>("select config from public.saved_views where name = 'לידים חמים'")).rows[0].config);
    expect(config.sort).toBe("-created");
  });

  it("a member cannot share with a team they are not in; an admin can share with any team", async () => {
    expect((await pgError(share(sales1.id, supportTeam, "לא שלי"))).code).toBe("42501");
    await share(owner.id, supportTeam, "של המנהל");
    expect(await visible(support.id, "של המנהל")).toBe(1);
  });

  it("only the owner of a view or an admin deletes it", async () => {
    await asUser(sales2.id, async (q) => expect((await q("delete from public.saved_views where name = 'לידים חמים'")).rowCount).toBe(0));
    await asUser(sales1.id, async (q) => expect((await q("delete from public.saved_views where name = 'לידים חמים'")).rowCount).toBe(1));
  });
});
