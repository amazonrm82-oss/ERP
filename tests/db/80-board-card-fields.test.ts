import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

// DEAL-09: each user's card fields on the deals board live in list_preferences under 'deal_board'
describe("board card fields are personal (list_preferences 'deal_board')", () => {
  let owner: { id: string }, member: { id: string }, viewer: { id: string }, outsider: { id: string };
  let org: string, otherOrg: string;

  const save = (userId: string, orgId: string, keys: string[]) =>
    asUser(userId, (q) =>
      q("insert into public.list_preferences (organization_id, object_type, columns) values ($1, 'deal_board', $2)", [
        orgId,
        JSON.stringify(keys.map((key) => ({ key, width: "normal" }))),
      ]),
    );

  beforeAll(async () => {
    owner = await createUser("board-fields-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member");
    viewer = await addMember(org, owner.id, "viewer");
    outsider = await createUser("board-fields-outsider");
    otherOrg = await createOrg(outsider.id);
  });

  it("every role, a viewer too, saves its own card fields beside its table columns", async () => {
    await save(member.id, org, ["amount", "owner", "cf:budget"]);
    await save(viewer.id, org, []);
    await asUser(member.id, (q) => q("insert into public.list_preferences (organization_id, object_type, columns) values ($1, 'deal', '[]')", [org]));
    const mine = await asUser(member.id, async (q) =>
      (await q<{ user_id: string; object_type: string }>("select user_id, object_type from public.list_preferences order by object_type")).rows,
    );
    expect(mine).toEqual([
      { user_id: member.id, object_type: "deal" },
      { user_id: member.id, object_type: "deal_board" },
    ]);
    // one row per user and list
    expect((await pgError(save(member.id, org, ["amount"]))).code).toBe("23505");
    // a row cannot be written for someone else
    expect(
      (await pgError(asUser(member.id, (q) => q("insert into public.list_preferences (organization_id, user_id, object_type) values ($1, $2, 'deal_board')", [org, owner.id])))).code,
    ).toBe("42501");
  });

  it("not even an admin reads or changes another user's card fields", async () => {
    await asUser(owner.id, async (q) => {
      expect(await count(q, "select 1 from public.list_preferences where object_type = 'deal_board'")).toBe(0);
      expect((await q("update public.list_preferences set columns = '[]' where object_type = 'deal_board'")).rowCount).toBe(0);
      expect((await q("delete from public.list_preferences where object_type = 'deal_board'")).rowCount).toBe(0);
    });
    expect(await asAdmin((q) => count(q, "select 1 from public.list_preferences where organization_id = $1 and object_type = 'deal_board'", [org]))).toBe(2);
  });

  it("a user changes only their own choice, and only in their organization", async () => {
    await asUser(member.id, async (q) => {
      const changed = await q("update public.list_preferences set columns = '[{\"key\": \"tags\", \"width\": \"normal\"}]' where object_type = 'deal_board' returning id");
      expect(changed.rowCount).toBe(1);
    });
    // not a member of the other organization
    expect((await pgError(save(member.id, otherOrg, ["amount"]))).code).toBe("42501");
    expect(await asUser(outsider.id, (q) => count(q, "select 1 from public.list_preferences where organization_id = $1", [org]))).toBe(0);
  });

  it("the list keys are still a closed list, and the shape is still checked", async () => {
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.list_preferences (organization_id, object_type) values ($1, 'task_board')", [org])))).code).toBe("23514");
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.list_preferences (organization_id, object_type, columns) values ($1, 'deal_board', '{}')", [org])))).code).toBe("23514");
  });
});
