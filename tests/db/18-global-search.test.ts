import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, createOrg, createUser, insertLead } from "./helpers";

afterAll(closePool);

type Hit = { id: string; title?: string; body?: string };
type Result = { leads: Hit[]; contacts: Hit[]; companies: Hit[]; deals: Hit[]; notes: Hit[] };

describe("global search", () => {
  let owner: { id: string }, member: { id: string }, outsider: { id: string };
  let org: string, otherOrg: string;
  let ownerLead: string, memberLead: string;

  const search = (userId: string, orgId: string, query: string) =>
    asUser(userId, async (q) => (await q<{ r: Result }>("select public.search_records($1, $2) as r", [orgId, query])).rows[0].r);

  beforeAll(async () => {
    owner = await createUser("search-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member");
    outsider = await createUser("search-outsider");
    otherOrg = await createOrg(outsider.id);
    ownerLead = await insertLead(owner.id, org, { full_name: "אברהם כהן", phone: "050-1234567", company_name: "שיפוצים בע\"מ" });
    memberLead = await insertLead(member.id, org, { full_name: "שרה לוי", owner_id: member.id });
    await insertLead(outsider.id, otherOrg, { full_name: "אברהם כהן" });
    await asUser(owner.id, async (q) => {
      await q("insert into public.contacts (organization_id, first_name, last_name, email) values ($1, 'משה', 'פרץ', 'moshe@example.test')", [org]);
      await q("insert into public.companies (organization_id, name, tax_id) values ($1, 'מאפיית השכונה', '514000000')", [org]);
      await q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'הלקוח ביקש הצעת מחיר למטבח', $2)", [org, ownerLead]);
    });
  });

  it("finds by name, with typos, final letters and phone in any format", async () => {
    expect((await search(owner.id, org, "כהן")).leads.map((l) => l.id)).toEqual([ownerLead]);
    // a final letter typed as a regular one, and a wrong letter
    expect((await search(owner.id, org, "כהנ")).leads.map((l) => l.id)).toContain(ownerLead);
    expect((await search(owner.id, org, "אברהמ כהו")).leads.map((l) => l.id)).toContain(ownerLead);
    for (const phone of ["0501234567", "+972-50-123-4567", "1234567"]) {
      expect((await search(owner.id, org, phone)).leads.map((l) => l.id)).toEqual([ownerLead]);
    }
    expect((await search(owner.id, org, "שיפוצים")).leads.map((l) => l.id)).toEqual([ownerLead]);
    expect((await search(owner.id, org, "moshe@")).contacts.map((c) => c.title)).toEqual(["משה פרץ"]);
    expect((await search(owner.id, org, "514000000")).companies.map((c) => c.title)).toEqual(["מאפיית השכונה"]);
    expect((await search(owner.id, org, "מטבח")).notes.map((n) => n.body)).toEqual(["הלקוח ביקש הצעת מחיר למטבח"]);
    // one letter is not a search
    expect((await search(owner.id, org, "כ")).leads).toEqual([]);
  });

  it("finds only what the user may see: not other businesses, not trash, and per visibility", async () => {
    expect((await search(outsider.id, org, "כהן")).leads).toEqual([]);
    expect((await search(owner.id, org, "כהן")).leads).toHaveLength(1);

    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    expect((await search(member.id, org, "כהן")).leads).toEqual([]);
    expect((await search(member.id, org, "שרה")).leads.map((l) => l.id)).toEqual([memberLead]);
    // a member does not find a note on a lead they cannot see
    expect((await search(member.id, org, "מטבח")).notes).toEqual([]);
    await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));

    await asAdmin((q) => q("update public.leads set deleted_at = now() where id = $1", [memberLead]));
    expect((await search(owner.id, org, "שרה")).leads).toEqual([]);
  });
});
