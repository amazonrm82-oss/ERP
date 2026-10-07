import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

describe("handing records to someone else", () => {
  let owner: U, admin: U, leaving: U, taking: U, viewer: U;
  let org: string;

  beforeAll(async () => {
    owner = await createUser("transfer-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin");
    leaving = await addMember(org, owner.id, "member");
    taking = await addMember(org, owner.id, "member");
    viewer = await addMember(org, owner.id, "viewer");
    await insertLead(leaving.id, org, { owner_id: leaving.id, full_name: "ליד פעיל" });
    const trashed = await insertLead(leaving.id, org, { owner_id: leaving.id, full_name: "ליד בסל" });
    await asAdmin(async (q) => {
      await q("update public.leads set deleted_at = now() where id = $1", [trashed]);
      await q("insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'איש קשר', $2)", [org, leaving.id]);
      await q("insert into public.tasks (organization_id, title, owner_id) values ($1, 'לחזור', $2), ($1, 'הושלמה', $2)", [org, leaving.id]);
      await q("update public.tasks set status = 'done', completed_at = now() where title = 'הושלמה' and organization_id = $1", [org]);
    });
  });

  const transfer = (actor: string, from: string, to: string) =>
    asUser(actor, async (q) => (await q<{ r: Record<string, number> }>("select public.transfer_records($1, $2, $3) as r", [org, from, to])).rows[0].r);

  it("only owners and admins, and only to an active user who can edit", async () => {
    expect((await pgError(transfer(taking.id, leaving.id, taking.id))).code).toBe("42501");
    expect((await pgError(transfer(admin.id, leaving.id, viewer.id))).hint).toBe("transfer:target");
    expect((await pgError(transfer(admin.id, leaving.id, leaving.id))).code).toBe("22023");
  });

  it("moves everything, sends one notification, starts no automation, and lets the person go", async () => {
    // before: the person cannot be removed while they own records
    expect((await pgError(asUser(leaving.id, (q) => q("delete from public.memberships where organization_id = $1 and user_id = $2", [org, leaving.id])))).code).toBe("23503");
    const outboxBefore = await asAdmin((q) => count(q, "select 1 from public.outbox_events where organization_id = $1 and coalesce(payload ->> 'origin', '') <> 'automation'", [org]));

    expect(await transfer(admin.id, leaving.id, taking.id)).toEqual({ leads: 2, contacts: 1, companies: 0, deals: 0, tasks: 2 });

    for (const table of ["leads", "contacts", "tasks"]) {
      expect(await asAdmin((q) => count(q, `select 1 from public.${table} where organization_id = $1 and owner_id = $2`, [org, leaving.id])), table).toBe(0);
    }
    const notes = await asAdmin(async (q) => (await q<{ title: string; body: string }>("select title, body from public.notifications where organization_id = $1 and user_id = $2", [org, taking.id])).rows);
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toContain("2 לידים");
    // the moves are in the outbox only as automation-made changes, which automations skip
    expect(await asAdmin((q) => count(q, "select 1 from public.outbox_events where organization_id = $1 and coalesce(payload ->> 'origin', '') <> 'automation'", [org]))).toBe(outboxBefore);
    // and the person can now leave
    await asUser(leaving.id, (q) => q("delete from public.memberships where organization_id = $1 and user_id = $2", [org, leaving.id]));
  });
});
