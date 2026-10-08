import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAdmin, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

describe("only the conversion marks a lead as converted (FXS-04)", () => {
  let owner: { id: string };
  let org: string;
  let lead: string;
  let contact: string;

  beforeAll(async () => {
    owner = await createUser("conv-cols-owner");
    org = await createOrg(owner.id);
    lead = await insertLead(owner.id, org, { full_name: "ליד" });
    contact = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'אחר') returning id", [org])).rows[0].id);
  });

  it("a user cannot set the conversion columns, on update or on insert", async () => {
    for (const set of ["converted_at = now()", `converted_contact_id = '${contact}'`, "converted_company_id = null", "converted_deal_id = null"]) {
      expect((await pgError(asUser(owner.id, (q) => q(`update public.leads set ${set} where id = $1`, [lead])))).code).toBe("42501");
    }
    expect(
      (await pgError(asUser(owner.id, (q) => q("insert into public.leads (organization_id, full_name, converted_at, converted_contact_id) values ($1, 'x', now(), $2)", [org, contact])))).code,
    ).toBe("42501");
  });

  it("the other columns are written as before, and convert_lead still converts", async () => {
    await asUser(owner.id, (q) => q("update public.leads set full_name = 'ליד חדש', message = 'הערה', custom_fields = '{}' where id = $1", [lead]));
    const result = await asUser(owner.id, async (q) => (await q<{ r: { contact_id: string } }>("select public.convert_lead($1, false, null, null) as r", [lead])).rows[0].r);
    const row = await asAdmin(async (q) => (await q<{ converted_contact_id: string; full_name: string }>("select converted_contact_id, full_name from public.leads where id = $1", [lead])).rows[0]);
    expect(row).toEqual({ converted_contact_id: result.contact_id, full_name: "ליד חדש" });
  });
});
