import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, defaultPipeline, pgError } from "./helpers";
import { migrationFile, rerunClosure } from "./rerun";

afterAll(closePool);

type U = { id: string };
type DbError = { code?: string; hint?: string; message: string };
const failure = async (promise: Promise<unknown>) => (await pgError(promise)) as DbError;

// CON-03 review follow-ups (migration deal_contact_role_text): the old role code on a deal contact is written by the
// server only, and a link saved before the list may keep the role it shows even after that default was hidden.
describe("the old role code on a deal contact (CON-03 review)", () => {
  let owner: U, admin: U, member: U, other: U;
  let org: string, otherOrg: string;
  let dealId: string;
  let contacts: string[];

  const roleId = (o: string, key: string) =>
    asAdmin(async (q) => (await q<{ id: string }>("select id from public.deal_contact_roles where organization_id = $1 and key = $2", [o, key])).rows[0].id);
  const link = (contact: string) =>
    asAdmin(async (q) => (await q<{ role: string | null; role_id: string | null }>("select role, role_id from public.deal_contacts where deal_id = $1 and contact_id = $2", [dealId, contact])).rows[0]);
  /** A link saved before the list: no role_id, the old code in `role` (written as the server). */
  const oldLink = (contact: string, code: string) =>
    asAdmin((q) => q("insert into public.deal_contacts (organization_id, deal_id, contact_id, role) values ($1, $2, $3, $4)", [org, dealId, contact, code]));
  const setRole = (user: U, contact: string, roleIdValue: string | null) =>
    asUser(user.id, (q) =>
      // the app's update: the picked role and the old code cleared together
      q("update public.deal_contacts set role_id = $3, role = null where deal_id = $1 and contact_id = $2 returning contact_id", [dealId, contact, roleIdValue]),
    );

  beforeAll(async () => {
    owner = await createUser("dcrt-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin");
    member = await addMember(org, owner.id, "member");
    other = await createUser("dcrt-other");
    otherOrg = await createOrg(other.id);
    const pipe = await defaultPipeline(org);
    ({ dealId, contacts } = await asUser(member.id, async (q) => {
      const deal = (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה', $2, $3) returning id", [org, pipe.pipelineId, pipe.stages[0].id])).rows[0].id;
      const ids: string[] = [];
      for (const name of ["א", "ב", "ג", "ד", "ה", "ו"]) ids.push((await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, $2) returning id", [org, name])).rows[0].id);
      return { dealId: deal, contacts: ids };
    }));
  });

  it("a person cannot write the old code, on insert or update, alone or next to a role from the list", async () => {
    const finance = await roleId(org, "finance");
    for (const user of [member, admin, owner]) {
      const insertCode = await failure(asUser(user.id, (q) => q("insert into public.deal_contacts (organization_id, deal_id, contact_id, role) values ($1, $2, $3, 'finance')", [org, dealId, contacts[0]])));
      expect(insertCode.hint).toBe("deal_contact_role:invalid");
      const insertBoth = await failure(asUser(user.id, (q) => q("insert into public.deal_contacts (organization_id, deal_id, contact_id, role, role_id) values ($1, $2, $3, 'user', $4)", [org, dealId, contacts[0], finance])));
      expect(insertBoth.hint).toBe("deal_contact_role:invalid");
    }
    expect(await link(contacts[0])).toBeUndefined();

    // a link with no role, and one with a role from the list: the code cannot be put on either
    await asUser(member.id, (q) => q("insert into public.deal_contacts (organization_id, deal_id, contact_id) values ($1, $2, $3)", [org, dealId, contacts[0]]));
    await asUser(member.id, (q) => q("insert into public.deal_contacts (organization_id, deal_id, contact_id, role_id) values ($1, $2, $3, $4)", [org, dealId, contacts[1], finance]));
    for (const contact of [contacts[0], contacts[1]]) {
      const update = await failure(asUser(member.id, (q) => q("update public.deal_contacts set role = 'finance' where deal_id = $1 and contact_id = $2", [dealId, contact])));
      expect(update.hint).toBe("deal_contact_role:invalid");
    }
    expect(await link(contacts[0])).toEqual({ role: null, role_id: null });
    expect(await link(contacts[1])).toEqual({ role: null, role_id: finance });
  });

  it("a link saved before the list keeps its code; a person may leave it as it is or clear it, not change it", async () => {
    await oldLink(contacts[2], "influencer");
    // an update that leaves the code as it is (the tenant tests' no-op update) passes
    expect((await asUser(member.id, (q) => q("update public.deal_contacts set role = role where deal_id = $1 and contact_id = $2", [dealId, contacts[2]]))).rowCount).toBe(1);
    expect(await link(contacts[2])).toEqual({ role: "influencer", role_id: null });
    // changing it to another code is refused
    expect((await failure(asUser(member.id, (q) => q("update public.deal_contacts set role = 'finance' where deal_id = $1 and contact_id = $2", [dealId, contacts[2]])))).hint).toBe("deal_contact_role:invalid");
    // clearing the role (the app sends role_id null and role null) clears the code
    expect((await setRole(member, contacts[2], null)).rowCount).toBe(1);
    expect(await link(contacts[2])).toEqual({ role: null, role_id: null });
  });

  it("an outsider gets RLS's plain refusal, not the role hint", async () => {
    const outsider = await failure(asUser(other.id, (q) => q("insert into public.deal_contacts (organization_id, deal_id, contact_id, role) values ($1, $2, $3, 'finance')", [org, dealId, contacts[5]])));
    expect(outsider.code).toBe("42501");
    expect(outsider.hint).not.toBe("deal_contact_role:invalid");
  });

  it("the server still writes the code", async () => {
    await asAdmin((q) => q("update public.deal_contacts set role = 'user' where deal_id = $1 and contact_id = $2", [dealId, contacts[0]]));
    expect(await link(contacts[0])).toEqual({ role: "user", role_id: null });
  });

  it("a link saved before the list may be saved with the hidden default it shows, and with no other hidden role", async () => {
    const user = await roleId(org, "user");
    const custom = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.deal_contact_roles (organization_id, name) values ($1, 'יועץ') returning id", [org])).rows[0].id);
    await oldLink(contacts[3], "user");
    await oldLink(contacts[4], "influencer");
    await asUser(owner.id, (q) => q("update public.deal_contact_roles set is_active = false where id = any($1)", [[user, custom]]));

    // contacts[3] shows "user" (by its code): saving that hidden role passes, and the code goes
    expect((await setRole(member, contacts[3], user)).rowCount).toBe(1);
    expect(await link(contacts[3])).toEqual({ role: null, role_id: user });
    // saved again, unchanged, it stays
    expect((await setRole(member, contacts[3], user)).rowCount).toBe(1);
    expect(await link(contacts[3])).toEqual({ role: null, role_id: user });

    // contacts[4] shows "influencer": the hidden "user", or a hidden role without a key, is still refused
    for (const hidden of [user, custom]) {
      expect((await failure(setRole(member, contacts[4], hidden))).hint).toBe("deal_contact_role:invalid");
    }
    // a new link may not take the hidden default either
    expect(
      (await failure(asUser(member.id, (q) => q("insert into public.deal_contacts (organization_id, deal_id, contact_id, role_id) values ($1, $2, $3, $4)", [org, dealId, contacts[5], user])))).hint,
    ).toBe("deal_contact_role:invalid");
    // another business's role with the same key is refused, before the composite foreign key would
    const foreignUser = await roleId(otherOrg, "user");
    await asUser(other.id, (q) => q("update public.deal_contact_roles set is_active = false where id = $1", [foreignUser]));
    await oldLink(contacts[5], "user");
    expect((await failure(setRole(member, contacts[5], foreignUser))).hint).toBe("deal_contact_role:invalid");
    expect(await link(contacts[5])).toEqual({ role: "user", role_id: null });
    expect(await link(contacts[4])).toEqual({ role: "influencer", role_id: null });
    await asUser(owner.id, (q) => q("update public.deal_contact_roles set is_active = true where id = any($1)", [[user, custom]]));
  });

  it("the migration is safe to run twice and changes no link", async () => {
    const snapshot = () =>
      asAdmin(async (q) => (await q("select deal_id, contact_id, role, role_id from public.deal_contacts where organization_id = $1 order by contact_id", [org])).rows);
    const before = await snapshot();
    const { sql } = rerunClosure([migrationFile("_deal_contact_role_text.sql")]);
    for (let i = 0; i < 2; i++) await asAdmin(async (q) => { for (const text of sql) await q(text); });
    expect(await snapshot()).toEqual(before);
  });
});
