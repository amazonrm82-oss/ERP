import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEAL_CONTACT_ROLES } from "@/features/deal-contacts/roles";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, defaultPipeline, pgError } from "./helpers";
import { migrationFile, rerunClosure } from "./rerun";

afterAll(closePool);

type U = { id: string };
type DbError = { code?: string; hint?: string; message: string };
const failure = async (promise: Promise<unknown>) => (await pgError(promise)) as DbError;

// CON-03 follow-up (owner, 14 October 2026; migration deal_contact_roles_list): the roles of a contact on a deal
// are a managed list per business, seeded with the four old roles; deal_contacts.role_id points at it, and the
// old code in deal_contacts.role stays as it was.
describe("roles of contacts on a deal as a managed list (CON-03 follow-up)", () => {
  let owner: U, admin: U, member: U, other: U;
  let org: string, otherOrg: string;
  let dealId: string, contactA: string, contactB: string, contactC: string;

  const rolesOf = (o: string) =>
    asAdmin(async (q) =>
      (await q<{ id: string; name: string; key: string | null; position: number; is_active: boolean }>(
        "select id, name, key, position, is_active from public.deal_contact_roles where organization_id = $1 order by position, created_at",
        [o],
      )).rows,
    );
  const roleId = async (o: string, key: string) => (await rolesOf(o)).find((r) => r.key === key)!.id;
  const link = (dealOf: string, contact: string) =>
    asAdmin(async (q) => (await q<{ role: string | null; role_id: string | null }>("select role, role_id from public.deal_contacts where deal_id = $1 and contact_id = $2", [dealOf, contact])).rows[0]);

  beforeAll(async () => {
    owner = await createUser("dcr-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin");
    member = await addMember(org, owner.id, "member");
    other = await createUser("dcr-other");
    otherOrg = await createOrg(other.id);
    const pipe = await defaultPipeline(org);
    ({ dealId, contactA, contactB, contactC } = await asUser(member.id, async (q) => {
      const deal = (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה', $2, $3) returning id", [org, pipe.pipelineId, pipe.stages[0].id])).rows[0].id;
      const ids: string[] = [];
      for (const name of ["א", "ב", "ג"]) ids.push((await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, $2) returning id", [org, name])).rows[0].id);
      return { dealId: deal, contactA: ids[0], contactB: ids[1], contactC: ids[2] };
    }));
  });

  it("every business starts with the four defaults, keys included", async () => {
    for (const o of [org, otherOrg]) {
      const rows = await rolesOf(o);
      expect(rows.map((r) => ({ key: r.key, label: r.name }))).toEqual(DEAL_CONTACT_ROLES.map(({ key, label }) => ({ key, label })));
      expect(rows.every((r) => r.is_active)).toBe(true);
    }
  });

  it("the seed fills only an empty list; a business that renamed or added keeps its list", async () => {
    await asUser(owner.id, (q) => q("update public.deal_contact_roles set name = 'מחליט סופי' where organization_id = $1 and key = 'decision_maker'", [org]));
    await asAdmin((q) => q("select app.seed_deal_contact_roles($1)", [org]));
    expect((await rolesOf(org)).map((r) => r.name)).toEqual(["מחליט סופי", "משפיע", "משתמש", "איש כספים"]);
  });

  it("owners and admins write the list; members read it; outsiders see nothing", async () => {
    await asUser(admin.id, (q) => q("insert into public.deal_contact_roles (organization_id, name, position) values ($1, 'יועץ משפטי', 4)", [org]));
    expect((await failure(asUser(member.id, (q) => q("insert into public.deal_contact_roles (organization_id, name) values ($1, 'x')", [org])))).code).toBe("42501");
    const seen = await asUser(member.id, async (q) => (await q("select count(*)::int as n from public.deal_contact_roles where organization_id = $1", [org])).rows[0].n);
    expect(seen).toBe(5);
    const outsider = await asUser(other.id, async (q) => (await q("select count(*)::int as n from public.deal_contact_roles where organization_id = $1", [org])).rows[0].n);
    expect(outsider).toBe(0);
    // the key is server-only (column grants)
    expect((await failure(asUser(owner.id, (q) => q("update public.deal_contact_roles set key = 'finance' where organization_id = $1 and name = 'יועץ משפטי'", [org])))).code).toBe("42501");
    expect((await failure(asUser(owner.id, (q) => q("insert into public.deal_contact_roles (organization_id, name, key) values ($1, 'y', 'user')", [org])))).code).toBe("42501");
    // names are unique per business, ignoring case
    expect((await failure(asUser(owner.id, (q) => q("insert into public.deal_contact_roles (organization_id, name) values ($1, 'משפיע')", [org])))).code).toBe("23505");
  });

  it("at most 20 per business; an outsider gets RLS's refusal, not the cap", async () => {
    const extra = await createUser("dcr-cap");
    const capOrg = await createOrg(extra.id);
    await asUser(extra.id, async (q) => {
      for (let i = 0; i < 16; i++) await q("insert into public.deal_contact_roles (organization_id, name) values ($1, $2)", [capOrg, `תפקיד ${i}`]);
    });
    const over = await failure(asUser(extra.id, (q) => q("insert into public.deal_contact_roles (organization_id, name) values ($1, 'עוד אחד')", [capOrg])));
    expect(over.hint).toBe("deal_contact_roles:max");
    const outsider = await failure(asUser(other.id, (q) => q("insert into public.deal_contact_roles (organization_id, name) values ($1, 'זר')", [capOrg])));
    expect(outsider.code).toBe("42501");
    expect(outsider.hint).not.toBe("deal_contact_roles:max");
  });

  it("a link takes an active role of the business; picking one drops the old code", async () => {
    const finance = await roleId(org, "finance");
    await asUser(member.id, (q) => q("insert into public.deal_contacts (organization_id, deal_id, contact_id, role_id) values ($1, $2, $3, $4)", [org, dealId, contactA, finance]));
    expect(await link(dealId, contactA)).toEqual({ role: null, role_id: finance });

    // a link saved before the list keeps its code untouched (only the server writes the code now)
    await asAdmin((q) => q("insert into public.deal_contacts (organization_id, deal_id, contact_id, role) values ($1, $2, $3, 'influencer')", [org, dealId, contactB]));
    expect(await link(dealId, contactB)).toEqual({ role: "influencer", role_id: null });
    // an edit that does not touch the role keeps it; picking a role from the list replaces the code
    const user = await roleId(org, "user");
    await asUser(member.id, (q) => q("update public.deal_contacts set role_id = $3 where deal_id = $1 and contact_id = $2", [dealId, contactB, user]));
    expect(await link(dealId, contactB)).toEqual({ role: null, role_id: user });

    // a hidden role is refused for a new pick, and stays on the links that have it
    await asUser(owner.id, (q) => q("update public.deal_contact_roles set is_active = false where id = $1", [user]));
    const hidden = await failure(asUser(member.id, (q) => q("insert into public.deal_contacts (organization_id, deal_id, contact_id, role_id) values ($1, $2, $3, $4)", [org, dealId, contactC, user])));
    expect(hidden.hint).toBe("deal_contact_role:invalid");
    expect((await link(dealId, contactB)).role_id).toBe(user);
    await asUser(owner.id, (q) => q("update public.deal_contact_roles set is_active = true where id = $1", [user]));

    // another business's role is refused (the check, before the composite foreign key would)
    const foreign = await roleId(otherOrg, "finance");
    expect((await failure(asUser(member.id, (q) => q("update public.deal_contacts set role_id = $3 where deal_id = $1 and contact_id = $2", [dealId, contactA, foreign])))).hint).toBe("deal_contact_role:invalid");
    expect((await failure(asAdmin((q) => q("update public.deal_contacts set role_id = $3 where deal_id = $1 and contact_id = $2", [dealId, contactA, foreign])))).code).toBe("23503");
  });

  it("deleting a role leaves the contact on the deal without a role", async () => {
    const role = (await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.deal_contact_roles (organization_id, name) values ($1, 'זמני') returning id", [org])).rows[0].id));
    await asUser(member.id, (q) => q("insert into public.deal_contacts (organization_id, deal_id, contact_id, role_id) values ($1, $2, $3, $4)", [org, dealId, contactC, role]));
    expect((await asUser(owner.id, (q) => q("delete from public.deal_contact_roles where id = $1 returning id", [role]))).rowCount).toBe(1);
    expect(await link(dealId, contactC)).toEqual({ role: null, role_id: null });
  });

  it("a member cannot change, hide or delete a role; changes are audited", async () => {
    const finance = await roleId(org, "finance");
    expect((await asUser(member.id, (q) => q("update public.deal_contact_roles set name = 'x' where id = $1 returning id", [finance]))).rowCount).toBe(0);
    expect((await asUser(member.id, (q) => q("delete from public.deal_contact_roles where id = $1 returning id", [finance]))).rowCount).toBe(0);
    await asUser(admin.id, (q) => q("update public.deal_contact_roles set name = 'כספים' where id = $1", [finance]));
    const audited = await asAdmin(async (q) =>
      (await q("select count(*)::int as n from public.audit_log where organization_id = $1 and entity_type = 'deal_contact_roles' and entity_id = $2 and action = 'update' and actor_id = $3", [org, finance, admin.id])).rows[0].n,
    );
    expect(audited).toBe(1);
  });

  it("the migration is safe to run twice and changes no link", async () => {
    const before = await asAdmin(async (q) => (await q("select deal_id, contact_id, role, role_id from public.deal_contacts where organization_id = $1 order by contact_id", [org])).rows);
    const names = (await rolesOf(org)).map((r) => r.name);
    const { sql } = rerunClosure([migrationFile("_deal_contact_roles_list.sql")]);
    for (let i = 0; i < 2; i++) await asAdmin(async (q) => { for (const text of sql) await q(text); });
    expect(await asAdmin(async (q) => (await q("select deal_id, contact_id, role, role_id from public.deal_contacts where organization_id = $1 order by contact_id", [org])).rows)).toEqual(before);
    expect((await rolesOf(org)).map((r) => r.name)).toEqual(names);
  });
});
