import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * Follow-up of REC-03: converting a lead makes its followers follow the new contact
 * and the new deal, only those who may read them, one row per user, and tells nobody
 * anything beyond what the conversion already announced.
 */
describe("conversion carries the lead's followers (REC-03 follow-up)", () => {
  let owner: U, admin: U, member: U, other: U;
  let org: string;

  beforeAll(async () => {
    owner = await createUser("cvf-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "cvf-admin");
    member = await addMember(org, owner.id, "member", "cvf-member");
    other = await addMember(org, owner.id, "member", "cvf-other");
  });

  const follow = (u: U, lead: string) =>
    asUser(u.id, (q) => q("insert into public.record_followers (organization_id, lead_id) values ($1, $2)", [org, lead]));
  const followersOf = (col: "lead_id" | "contact_id" | "deal_id", id: string) =>
    asAdmin(async (q) =>
      (await q<{ user_id: string }>(`select user_id::text from public.record_followers where ${col} = $1 order by user_id::text collate "C"`, [id])).rows.map(
        (r) => r.user_id,
      ),
    );
  const sorted = (ids: string[]) => [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const followNotes = (u: U) =>
    asAdmin(async (q) =>
      (
        await q<{ entity_type: string; entity_id: string }>(
          "select entity_type, entity_id from public.notifications where user_id = $1 and type = 'follow' order by created_at, id",
          [u.id],
        )
      ).rows,
    );
  const convert = (u: U, lead: string, withDeal = true) =>
    asUser(u.id, async (q) =>
      (await q<{ r: { contact_id: string; deal_id: string | null } }>("select public.convert_lead($1, $2, null, 0) as r", [lead, withDeal])).rows[0].r,
    );

  it("followers of the lead follow the new contact and deal; the lead keeps its followers; nobody is told more", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "ליד במעקב" });
    await follow(owner, lead);
    await follow(admin, lead);
    await follow(member, lead);
    const before = { owner: (await followNotes(owner)).length, admin: (await followNotes(admin)).length, member: (await followNotes(member)).length };

    const result = await convert(owner, lead);
    const all = sorted([owner.id, admin.id, member.id]);
    expect(await followersOf("contact_id", result.contact_id)).toEqual(all);
    expect(await followersOf("deal_id", result.deal_id!)).toEqual(all);
    expect(await followersOf("lead_id", lead)).toEqual(all);

    // the converter is told nothing; the others hear only about the lead's status change, as before
    expect((await followNotes(owner)).length).toBe(before.owner);
    for (const u of [admin, member]) {
      const got = (await followNotes(u)).slice(u === admin ? before.admin : before.member);
      expect(got).toEqual([{ entity_type: "lead", entity_id: lead }]);
    }
    // the new rows can be seen and stopped by their users
    expect(await asUser(member.id, (q) => count(q, "select 1 from public.record_followers where contact_id = $1", [result.contact_id]))).toBe(3);
    await asUser(member.id, (q) => q("delete from public.record_followers where contact_id = $1 and user_id = $2", [result.contact_id, member.id]));
    expect(await followersOf("contact_id", result.contact_id)).toEqual(sorted([owner.id, admin.id]));
  });

  it("without a deal, followers follow the contact only", async () => {
    const lead = await insertLead(owner.id, org);
    await follow(member, lead);
    const dealRows = () => asAdmin((q) => count(q, "select 1 from public.record_followers where user_id = $1 and deal_id is not null", [member.id]));
    const before = await dealRows();
    const result = await convert(owner, lead, false);
    expect(result.deal_id).toBeNull();
    expect(await followersOf("contact_id", result.contact_id)).toEqual([member.id]);
    expect(await dealRows()).toBe(before);
  });

  it("a lead with no followers converts as before", async () => {
    const lead = await insertLead(owner.id, org);
    const result = await convert(owner, lead);
    expect(await followersOf("contact_id", result.contact_id)).toEqual([]);
    expect(await followersOf("deal_id", result.deal_id!)).toEqual([]);
  });

  it("a follower who may not read the new contact and deal does not follow them (visibility own)", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "ליד פרטי" });
    await follow(member, lead);
    await follow(admin, lead);
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const result = await convert(owner, lead);
      expect(await followersOf("contact_id", result.contact_id)).toEqual([admin.id]);
      expect(await followersOf("deal_id", result.deal_id!)).toEqual([admin.id]);
      // the member's row on the lead stays
      expect(await followersOf("lead_id", lead)).toEqual(sorted([member.id, admin.id]));
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("a suspended follower is not added", async () => {
    const lead = await insertLead(owner.id, org);
    await follow(other, lead);
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, other.id]));
    try {
      const result = await convert(owner, lead);
      expect(await followersOf("contact_id", result.contact_id)).toEqual([]);
    } finally {
      await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, other.id]));
    }
  });

  it("a user who already follows the contact keeps one row and the conversion does not fail", async () => {
    // convert_lead() always creates a new contact; the trigger is checked directly with an existing one
    const lead = await insertLead(owner.id, org);
    await follow(member, lead);
    await follow(admin, lead);
    const contact = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'קיים') returning id", [org])).rows[0].id,
    );
    await asUser(member.id, (q) => q("insert into public.record_followers (organization_id, contact_id) values ($1, $2)", [org, contact]));
    await asAdmin((q) => q("update public.leads set converted_at = now(), converted_contact_id = $2 where id = $1", [lead, contact]));
    expect(await followersOf("contact_id", contact)).toEqual(sorted([member.id, admin.id]));
    // setting converted_at again (already set) adds nothing
    await asUser(admin.id, (q) => q("delete from public.record_followers where contact_id = $1 and user_id = $2", [contact, admin.id]));
    await asAdmin((q) => q("update public.leads set converted_at = now() where id = $1", [lead]));
    expect(await followersOf("contact_id", contact)).toEqual([member.id]);
  });
  it("a contact or deal in the recycle bin gets no followers", async () => {
    const lead = await insertLead(owner.id, org);
    await follow(member, lead);
    const { contact, deal } = await asUser(owner.id, async (q) => {
      const r = (await q<{ r: { contact_id: string; deal_id: string } }>("select public.convert_lead($1, true, null, 0) as r", [await insertLead(owner.id, org)])).rows[0].r;
      return { contact: r.contact_id, deal: r.deal_id };
    });
    await asAdmin(async (q) => {
      await q("update public.contacts set deleted_at = now() where id = $1", [contact]);
      await q("update public.deals set deleted_at = now() where id = $1", [deal]);
      await q("update public.leads set converted_at = now(), converted_contact_id = $2, converted_deal_id = $3 where id = $1", [lead, contact, deal]);
    });
    expect(await followersOf("contact_id", contact)).toEqual([]);
    expect(await followersOf("deal_id", deal)).toEqual([]);
  });

  it("a merge that gives a never-converted kept lead its duplicate's conversion carries the kept lead's followers (intended)", async () => {
    const keep = await insertLead(owner.id, org, { full_name: "נשאר" });
    const dup = await insertLead(owner.id, org, { full_name: "כפול" });
    const result = await convert(owner, dup);
    await follow(member, keep);
    expect(await followersOf("contact_id", result.contact_id)).toEqual([]);
    await asUser(owner.id, (q) => q("select public.merge_records($1, 'lead', $2, $3, '{}'::jsonb)", [org, keep, dup]));
    expect(await asAdmin(async (q) => (await q<{ c: string }>("select converted_contact_id::text as c from public.leads where id = $1", [keep])).rows[0].c)).toBe(
      result.contact_id,
    );
    expect(await followersOf("contact_id", result.contact_id)).toEqual([member.id]);
    expect(await followersOf("deal_id", result.deal_id!)).toEqual([member.id]);
  });
});
