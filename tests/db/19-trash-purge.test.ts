import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead } from "./helpers";

afterAll(closePool);

describe("permanent deletion from the recycle bin", () => {
  let owner: { id: string }, admin: { id: string }, member: { id: string };
  let org: string;

  beforeAll(async () => {
    owner = await createUser("purge-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin");
    member = await addMember(org, owner.id, "member");
  });

  const rows = (sql: string, params: unknown[]) => asAdmin((q) => count(q, sql, params));

  it("purging a converted lead keeps the contact's history, and removes what was the lead's alone", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "ליד שהומר" });
    const ids = await asAdmin(async (q) => {
      const contact = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'איש קשר') returning id", [org])).rows[0].id;
      const shared = (await q<{ id: string }>("insert into public.activities (organization_id, type, body, lead_id, contact_id) values ($1, 'call', 'שיחה משותפת', $2, $3) returning id", [org, lead, contact])).rows[0].id;
      const own = (await q<{ id: string }>("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'רק של הליד', $2) returning id", [org, lead])).rows[0].id;
      const sharedTask = (await q<{ id: string }>("insert into public.tasks (organization_id, title, owner_id, lead_id, contact_id) values ($1, 'משימה משותפת', $2, $3, $4) returning id", [org, owner.id, lead, contact])).rows[0].id;
      const ownTask = (await q<{ id: string }>("insert into public.tasks (organization_id, title, owner_id, lead_id) values ($1, 'משימה של הליד', $2, $3) returning id", [org, owner.id, lead])).rows[0].id;
      const loose = (await q<{ id: string }>("insert into public.tasks (organization_id, title, owner_id) values ($1, 'משימה כללית', $2) returning id", [org, owner.id])).rows[0].id;
      await q("insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id) values ($1, $2, 'assigned', 'ליד חדש', 'lead', $3)", [org, owner.id, lead]);
      return { contact, shared, own, sharedTask, ownTask, loose };
    });

    // not in the bin yet: even an admin cannot delete it
    await asUser(admin.id, async (q) => expect((await q("delete from public.leads where id = $1", [lead])).rowCount).toBe(0));
    await asUser(owner.id, (q) => q("update public.leads set deleted_at = now() where id = $1", [lead]));
    // in the bin: a member cannot purge, an admin can
    await asUser(member.id, async (q) => expect((await q("delete from public.leads where id = $1", [lead])).rowCount).toBe(0));
    await asUser(admin.id, async (q) => expect((await q("delete from public.leads where id = $1", [lead])).rowCount).toBe(1));

    expect(await rows("select 1 from public.activities where id = $1 and lead_id is null and contact_id = $2", [ids.shared, ids.contact])).toBe(1);
    expect(await rows("select 1 from public.activities where id = $1", [ids.own])).toBe(0);
    expect(await rows("select 1 from public.tasks where id = $1 and lead_id is null", [ids.sharedTask])).toBe(1);
    expect(await rows("select 1 from public.tasks where id = $1", [ids.ownTask])).toBe(0);
    expect(await rows("select 1 from public.tasks where id = $1", [ids.loose])).toBe(1);
    expect(await rows("select 1 from public.notifications where entity_id = $1", [lead])).toBe(0);
    // the deletion is in the audit log
    expect(await rows("select 1 from public.audit_log where entity_id = $1 and action = 'delete'", [lead])).toBe(1);
  });

  it("the nightly job empties what has been in the bin for 30 days", async () => {
    const old = await insertLead(owner.id, org, { full_name: "ישן" });
    const recent = await insertLead(owner.id, org, { full_name: "חדש" });
    await asAdmin(async (q) => {
      await q("update public.leads set deleted_at = now() - interval '31 days' where id = $1", [old]);
      await q("update public.leads set deleted_at = now() - interval '29 days' where id = $1", [recent]);
      await q("select app.purge_trash()");
    });
    expect(await rows("select 1 from public.leads where id = $1", [old])).toBe(0);
    expect(await rows("select 1 from public.leads where id = $1", [recent])).toBe(1);
    await asUser(owner.id, async (q) => {
      // nobody calls it from the API
      await expect(q("select app.purge_trash()")).rejects.toMatchObject({ code: "42501" });
    });
  });
});
