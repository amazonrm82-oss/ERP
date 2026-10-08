import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

describe("custom fields and tags are merged in the database (FXD-04)", () => {
  let owner: { id: string }, rep: { id: string };
  let org: string, otherOrg: string;
  let lead: string;

  beforeAll(async () => {
    owner = await createUser("merge-owner");
    org = await createOrg(owner.id);
    rep = await addMember(org, owner.id, "member", "merge-rep");
    const outsider = await createUser("merge-outsider");
    otherOrg = await createOrg(outsider.id);
    await asUser(owner.id, (q) =>
      q(
        `insert into public.field_definitions (organization_id, object_type, key, label, field_type)
         values ($1, 'lead', 'size', 'גודל', 'text'), ($1, 'lead', 'notes', 'הערות', 'text'), ($1, 'lead', 'hidden', 'מוסתר', 'text')`,
        [org],
      ),
    );
    lead = await insertLead(owner.id, org, { full_name: "ליד", custom_fields: { size: "גדול", notes: "א", hidden: "נשאר" } });
  });

  const fields = () => asAdmin(async (q) => (await q<{ f: Record<string, string> }>("select custom_fields as f from public.leads where id = $1", [lead])).rows[0].f);
  const merge = (patch: Record<string, unknown>) =>
    asUser(owner.id, (q) => q("update public.leads set custom_fields = jsonb_build_object('$merge', $2::jsonb) where id = $1", [lead, JSON.stringify(patch)]));

  it("a merge changes only the fields it names; null removes one; the rest stay", async () => {
    await merge({ size: "קטן", notes: null });
    expect(await fields()).toEqual({ size: "קטן", hidden: "נשאר" });
  });

  it("two editors who each saw the old values do not overwrite each other", async () => {
    await merge({ size: "בינוני" });
    await merge({ notes: "ב" });
    expect(await fields()).toEqual({ size: "בינוני", notes: "ב", hidden: "נשאר" });
  });

  it("the merged result is still checked: an unknown field is refused", async () => {
    expect((await pgError(merge({ nope: "x" }))).hint).toBe("custom_field:invalid");
    expect((await pgError(asUser(owner.id, (q) => q("update public.leads set custom_fields = '{\"$merge\": [1]}' where id = $1", [lead])))).code).toBe("22023");
  });

  it("tags are added and removed in one statement, only the organization's own", async () => {
    const [vip, hot] = await asUser(owner.id, async (q) => [
      (await q<{ id: string }>("insert into public.tags (organization_id, name) values ($1, 'VIP') returning id", [org])).rows[0].id,
      (await q<{ id: string }>("insert into public.tags (organization_id, name) values ($1, 'חם') returning id", [org])).rows[0].id,
    ]);
    const theirs = await asAdmin(async (q) => (await q<{ id: string }>("insert into public.tags (organization_id, name) values ($1, 'זר') returning id", [otherOrg])).rows[0].id);
    const change = (as: string, add: string[], remove: string[]) =>
      asUser(as, async (q) => (await q<{ r: boolean }>("select public.change_record_tags('leads', $1, $2, $3::uuid[], $4::uuid[]) as r", [org, lead, add, remove])).rows[0].r);
    const tags = () => asAdmin(async (q) => (await q<{ t: string[] }>("select tag_ids as t from public.leads where id = $1", [lead])).rows[0].t.sort());

    expect(await change(owner.id, [vip, theirs], [])).toBe(true);
    expect(await tags()).toEqual([vip]);
    expect(await change(owner.id, [hot], [])).toBe(true);
    expect(await tags()).toEqual([vip, hot].sort());
    expect(await change(owner.id, [], [vip])).toBe(true);
    expect(await tags()).toEqual([hot]);
    // a member may not edit the owner's lead: nothing changes
    expect(await change(rep.id, [vip], [])).toBe(false);
    expect(await tags()).toEqual([hot]);
    expect((await pgError(asUser(owner.id, (q) => q("select public.change_record_tags('tasks', $1, $2, '{}', '{}')", [org, lead])))).code).toBe("22023");
  });
});
