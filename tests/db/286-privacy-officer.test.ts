import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

/** PRK-06: one privacy officer per business; an active member; cleared on suspension or leaving; no data rights. */
describe("privacy officer (PRK-06)", () => {
  let owner: { id: string };
  let other: { id: string };
  let member: { id: string };
  let second: { id: string };
  let org: string;
  let otherOrg: string;
  const officer = (o: string) =>
    asAdmin(async (q) => (await q<{ id: string | null }>("select app.privacy_officer($1) as id", [o])).rows[0].id);
  const stored = (o: string) =>
    asAdmin(async (q) => (await q<{ id: string | null }>("select privacy_officer_id as id from public.org_privacy_settings where organization_id = $1", [o])).rows[0]?.id ?? null);

  beforeAll(async () => {
    owner = await createUser("prk-owner");
    other = await createUser("prk-other");
    org = await createOrg(owner.id);
    otherOrg = await createOrg(other.id);
    member = await addMember(org, owner.id, "member", "prk-member");
    second = await addMember(org, owner.id, "member", "prk-second");
  });

  it("no row = no officer; the officer must be an active member of this business", async () => {
    expect(await officer(org)).toBeNull();
    const refused = await pgError(
      asUser(owner.id, (q) => q("insert into public.org_privacy_settings (organization_id, privacy_officer_id) values ($1, $2)", [org, other.id])),
    );
    // not a member at all: the composite FK or the check refuses it
    expect(["P0001", "23503"]).toContain(refused.code);
    await asUser(owner.id, (q) => q("insert into public.org_privacy_settings (organization_id, privacy_officer_id) values ($1, $2)", [org, member.id]));
    expect(await officer(org)).toBe(member.id);
    expect(await officer(otherOrg)).toBeNull();
  });

  it("a suspended member cannot be named", async () => {
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, second.id]));
    try {
      const refused = await pgError(asUser(owner.id, (q) => q("update public.org_privacy_settings set privacy_officer_id = $2 where organization_id = $1", [org, second.id])));
      expect(refused.code).toBe("P0001");
      expect(refused.hint).toBe("privacy_officer:member");
    } finally {
      await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, second.id]));
    }
  });

  it("suspending the officer clears the mark; a return does not bring it back", async () => {
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, member.id]));
    expect(await stored(org)).toBeNull();
    await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, member.id]));
    expect(await stored(org)).toBeNull();
  });

  it("a member who leaves the business stops being its officer", async () => {
    await asUser(owner.id, (q) => q("update public.org_privacy_settings set privacy_officer_id = $2 where organization_id = $1", [org, second.id]));
    expect(await officer(org)).toBe(second.id);
    await asAdmin((q) => q("delete from public.memberships where organization_id = $1 and user_id = $2", [org, second.id]));
    expect(await stored(org)).toBeNull();
  });

  it("an outsider neither reads nor sets another business's officer, and gets no hint about its members", async () => {
    expect(await asUser(other.id, (q) => count(q, "select 1 from public.org_privacy_settings where organization_id = $1", [org]))).toBe(0);
    expect(await asUser(other.id, async (q) => (await q("update public.org_privacy_settings set privacy_officer_id = $2 where organization_id = $1", [org, other.id])).rowCount)).toBe(0);
    // an outsider's insert: RLS's plain refusal, never the member hint
    const refused = await pgError(asUser(other.id, (q) => q("insert into public.org_privacy_settings (organization_id, privacy_officer_id) values ($1, $2)", [org, member.id])));
    expect(refused.code).toBe("42501");
    expect(await stored(org)).toBeNull();
  });

  it("the mark adds no rights on data", async () => {
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    const lead = await insertLead(owner.id, org, { full_name: "לקוח פרטי", owner_id: owner.id });
    const before = await asUser(member.id, (q) => count(q, "select 1 from public.leads where id = $1", [lead]));
    await asUser(owner.id, (q) => q("update public.org_privacy_settings set privacy_officer_id = $2 where organization_id = $1", [org, member.id]));
    expect(await asUser(member.id, (q) => count(q, "select 1 from public.leads where id = $1", [lead]))).toBe(before);
    expect(before).toBe(0);
    expect(await asUser(member.id, (q) => count(q, "select 1 from public.audit_log where organization_id = $1", [org]))).toBe(0);
    // and the officer cannot move the mark
    expect(await asUser(member.id, async (q) => (await q("update public.org_privacy_settings set privacy_officer_id = null where organization_id = $1", [org])).rowCount)).toBe(0);
  });

  it("nobody but the server asks who the officer is", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      const can = await asAdmin(async (q) => (await q<{ c: boolean }>("select has_function_privilege($1, 'app.privacy_officer(uuid)', 'execute') as c", [role])).rows[0].c);
      expect(can, role).toBe(false);
    }
  });

  it("every change is in the audit log", async () => {
    const entries = await asAdmin(async (q) =>
      count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type = 'org_privacy_settings'", [org]),
    );
    expect(entries).toBeGreaterThanOrEqual(4);
  });
});
