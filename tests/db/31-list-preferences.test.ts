import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

describe("list columns are personal (list_preferences)", () => {
  let owner: { id: string }, member: { id: string }, viewer: { id: string };
  let org: string;

  beforeAll(async () => {
    owner = await createUser("cols-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member");
    viewer = await addMember(org, owner.id, "viewer");
  });

  const save = (userId: string, columns: unknown) =>
    asUser(userId, (q) => q("insert into public.list_preferences (organization_id, object_type, columns) values ($1, 'lead', $2)", [org, JSON.stringify(columns)]));

  it("every role, a viewer too, keeps its own columns; user_id comes from the session", async () => {
    await save(member.id, [{ key: "email", width: "wide" }]);
    await save(viewer.id, [{ key: "phone" }]);
    const mine = await asUser(member.id, async (q) => (await q<{ user_id: string; columns: unknown }>("select user_id, columns from public.list_preferences")).rows);
    expect(mine).toEqual([{ user_id: member.id, columns: [{ key: "email", width: "wide" }] }]);
    // a row cannot be written for someone else
    expect(
      (await pgError(asUser(member.id, (q) => q("insert into public.list_preferences (organization_id, user_id, object_type) values ($1, $2, 'contact')", [org, owner.id])))).code,
    ).toBe("42501");
  });

  it("not even an admin reads or changes another user's columns", async () => {
    await asUser(owner.id, async (q) => {
      expect(await count(q, "select 1 from public.list_preferences where user_id <> $1", [owner.id])).toBe(0);
      expect((await q("update public.list_preferences set columns = '[]'")).rowCount).toBe(0);
      expect((await q("delete from public.list_preferences")).rowCount).toBe(0);
    });
    const left = await asAdmin((q) => count(q, "select 1 from public.list_preferences where organization_id = $1", [org]));
    expect(left).toBe(2);
  });

  it("one row per user and list; the shape and size are checked", async () => {
    expect((await pgError(save(member.id, []))).code).toBe("23505");
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.list_preferences (organization_id, object_type, columns) values ($1, 'note', '[]')", [org])))).code).toBe("23514");
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.list_preferences (organization_id, object_type, columns) values ($1, 'lead', '{}')", [org])))).code).toBe("23514");
    const tooMany = Array.from({ length: 61 }, (_, i) => ({ key: `k${i}` }));
    expect((await pgError(save(owner.id, tooMany))).code).toBe("23514");
  });

  it("a member who leaves takes their columns along", async () => {
    await asUser(owner.id, (q) => q("delete from public.memberships where organization_id = $1 and user_id = $2", [org, viewer.id]));
    expect(await asAdmin((q) => count(q, "select 1 from public.list_preferences where user_id = $1", [viewer.id]))).toBe(0);
  });
});
