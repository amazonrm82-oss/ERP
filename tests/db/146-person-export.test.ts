import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

// PRV-02: the audit entry written before a person's export is handed over (owners and admins only).
describe("person export log", () => {
  type U = { id: string };
  let owner: U, admin: U, manager: U, member: U, viewer: U, outsider: U;
  let org: string, otherOrg: string, lead: string, contact: string, otherLead: string, otherContact: string;

  const log = (userId: string, kind: string, id: string, orgId = () => org, rows = 7, files = 2) =>
    asUser(userId, (q) => q("select public.log_person_export($1, $2, $3, $4, $5)", [orgId(), kind, id, rows, files]));
  const entries = (id: string) =>
    asAdmin(async (q) =>
      (
        await q<{ actor_id: string; entity_type: string; changes: Record<string, unknown> }>(
          "select actor_id, entity_type, changes from public.audit_log where organization_id = $1 and action = 'person_export' and entity_id = $2 order by created_at",
          [org, id],
        )
      ).rows,
    );

  beforeAll(async () => {
    owner = await createUser("prv02-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "prv02-admin");
    manager = await addMember(org, owner.id, "manager", "prv02-manager");
    member = await addMember(org, owner.id, "member", "prv02-member");
    viewer = await addMember(org, owner.id, "viewer", "prv02-viewer");
    outsider = await createUser("prv02-outsider");
    otherOrg = await createOrg(outsider.id);
    lead = await insertLead(member.id, org, { owner_id: member.id });
    contact = await asAdmin(async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'דנה') returning id", [org])).rows[0].id,
    );
    otherLead = await insertLead(outsider.id, otherOrg, { owner_id: outsider.id });
    otherContact = await asAdmin(async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'זר') returning id", [otherOrg])).rows[0].id,
    );
  });

  it("owners and admins log it, with the counts only", async () => {
    await log(owner.id, "lead", lead);
    await log(admin.id, "contact", contact, () => org, 3, 0);
    expect(await entries(lead)).toEqual([{ actor_id: owner.id, entity_type: "leads", changes: { rows: 7, file_count: 2 } }]);
    expect(await entries(contact)).toEqual([{ actor_id: admin.id, entity_type: "contacts", changes: { rows: 3, file_count: 0 } }]);
  });

  it("managers, members, viewers and outsiders cannot", async () => {
    for (const u of [manager, member, viewer, outsider]) {
      expect((await pgError(log(u.id, "lead", lead))).code).toBe("42501");
    }
    expect(await entries(lead)).toHaveLength(1);
  });

  it("only a lead or a contact of this business, with sane counts", async () => {
    expect((await pgError(log(owner.id, "deal", lead))).code).toBe("22023");
    expect((await pgError(log(owner.id, "lead", lead, () => org, -1))).code).toBe("22023");
    expect((await pgError(log(owner.id, "lead", lead, () => org, 1, -1))).code).toBe("22023");
    // a lead of another business, a contact id given as a lead, an id that does not exist
    expect((await pgError(log(owner.id, "lead", otherLead))).code).toBe("P0002");
    expect((await pgError(log(owner.id, "contact", otherContact))).code).toBe("P0002");
    expect((await pgError(log(owner.id, "lead", contact))).code).toBe("P0002");
    expect((await pgError(log(owner.id, "contact", lead))).code).toBe("P0002");
    // the other business's owner cannot log against this business's lead through their own business either
    expect((await pgError(log(outsider.id, "lead", lead, () => otherOrg))).code).toBe("P0002");
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and action = 'person_export'", [otherOrg]))).toBe(0);
  });

  it("a record in the recycle bin can still be exported", async () => {
    const binned = await insertLead(member.id, org, { owner_id: member.id });
    await asAdmin((q) => q("update public.leads set deleted_at = now() where id = $1", [binned]));
    await log(admin.id, "lead", binned);
    expect(await entries(binned)).toHaveLength(1);
  });

  it("in a business closed until payment only the owner can", async () => {
    const before = await asAdmin(async (q) => (await q<{ status: string }>("select status from public.organizations where id = $1", [org])).rows[0].status);
    await asAdmin((q) => q("update public.organizations set status = 'suspended' where id = $1", [org]));
    try {
      expect((await pgError(log(admin.id, "lead", lead))).code).toBe("42501");
      await log(owner.id, "lead", lead);
      expect(await entries(lead)).toHaveLength(2);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = $2 where id = $1", [org, before]));
    }
  });

  it("nobody writes the entry by hand", async () => {
    expect(
      (
        await pgError(
          asUser(owner.id, (q) =>
            q("insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes) values ($1, $2, 'person_export', 'leads', $3, '{}')", [org, owner.id, lead]),
          ),
        )
      ).code,
    ).toBe("42501");
  });
});
