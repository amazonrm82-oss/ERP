import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

// A new timeline entry may link only records the user can see: linking one of their own
// records does not open a door to a record they cannot see.
describe("a new activity links only visible records", () => {
  let owner: U, m1: U, m2: U, stranger: U;
  let org: string, otherOrg: string, leadM1: string, leadM2: string, contactM1: string, strangerLead: string;

  beforeAll(async () => {
    owner = await createUser("subj-owner");
    org = await createOrg(owner.id);
    m1 = await addMember(org, owner.id, "member", "subj-m1");
    m2 = await addMember(org, owner.id, "member", "subj-m2");
    stranger = await createUser("subj-stranger");
    otherOrg = await createOrg(stranger.id, "עסק אחר");
    // 'own': a member sees only their own records
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    leadM1 = await insertLead(m1.id, org, { full_name: "ליד של m1" });
    leadM2 = await insertLead(m2.id, org, { full_name: "ליד של m2" });
    contactM1 = await asUser(m1.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'דנה') returning id", [org])).rows[0].id,
    );
    strangerLead = await insertLead(stranger.id, otherOrg);
  });

  const insert = (user: U, orgId: string, links: Record<string, string>) => {
    const columns = Object.keys(links);
    return asUser(user.id, (q) =>
      q(
        `insert into public.activities (organization_id, type, body, ${columns.join(", ")}) values ($1, 'note', 'בדיקה', ${columns.map((_, i) => `$${i + 2}`).join(", ")})`,
        [orgId, ...Object.values(links)],
      ),
    );
  };
  const onLead = (lead: string) => asAdmin((q) => count(q, "select 1 from public.activities where lead_id = $1", [lead]));

  it("a member still logs a note on their own lead, contact, or both", async () => {
    await insert(m1, org, { lead_id: leadM1 });
    await insert(m1, org, { contact_id: contactM1 });
    await insert(m1, org, { lead_id: leadM1, contact_id: contactM1 });
    expect(await onLead(leadM1)).toBe(2);
  });

  it("a member cannot link a lead they cannot see, alone or next to their own contact", async () => {
    expect(await asUser(m1.id, (q) => count(q, "select 1 from public.leads where id = $1", [leadM2]))).toBe(0);
    for (const links of [{ lead_id: leadM2 }, { lead_id: leadM2, contact_id: contactM1 }] as Record<string, string>[]) {
      const error = await pgError(insert(m1, org, links));
      expect(error.code).toBe("42501");
      expect(error.message).toMatch(/row-level security/);
    }
    expect(await onLead(leadM2)).toBe(0);
  });

  it("whoever sees both records may link both", async () => {
    await insert(owner, org, { lead_id: leadM2, contact_id: contactM1 });
    expect(await onLead(leadM2)).toBe(1);
  });

  it("another organization cannot link its records into ours, nor ours into its own", async () => {
    expect((await pgError(insert(stranger, org, { lead_id: leadM1 }))).code).toBe("42501");
    // the composite foreign key or the policy refuses a lead of another organization
    expect((await pgError(insert(stranger, otherOrg, { lead_id: strangerLead, contact_id: contactM1 }))).code).toMatch(/^(42501|23503)$/);
    expect(await onLead(strangerLead)).toBe(0);
  });
});
