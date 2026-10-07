import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, createOrg, createUser, insertLead } from "./helpers";

afterAll(closePool);

describe("a lead's custom fields follow it when it is converted", () => {
  let owner: { id: string }, rep: { id: string };
  let org: string;

  beforeAll(async () => {
    owner = await createUser("carry-owner");
    org = await createOrg(owner.id);
    rep = await addMember(org, owner.id, "member");
    await asAdmin(async (q) => {
      const add = (type: string, key: string, label: string, fieldType: string, options: string[] = [], active = true) =>
        q("insert into public.field_definitions (organization_id, object_type, key, label, field_type, options, is_active) values ($1, $2, $3, $4, $5, $6, $7)", [
          org,
          type,
          key,
          label,
          fieldType,
          JSON.stringify(options),
          active,
        ]);
      await add("lead", "budget", "תקציב", "number");
      await add("lead", "area", "תחום", "select", ["שיווק", "מכירות"]);
      await add("lead", "meet", "תאריך פגישה", "date");
      await add("lead", "notes", "הערה", "text");
      // the contact: same label and type (spaces and case ignored), another key
      await add("contact", "c_budget", " תקציב ", "number");
      await add("contact", "c_meet", "תאריך פגישה", "text"); // another type: not copied
      // the deal: a select with only one of the options
      await add("deal", "d_area", "תחום", "select", ["מכירות"]);
      await add("deal", "d_notes", "הערה", "text", [], false); // hidden: not copied
    });
  });

  const convert = (leadId: string) =>
    asUser(rep.id, async (q) => (await q<{ r: { contact_id: string; deal_id: string } }>("select public.convert_lead($1) as r", [leadId])).rows[0].r);
  const customOf = (table: string, id: string) =>
    asAdmin(async (q) => (await q<{ c: Record<string, unknown> }>(`select custom_fields as c from public.${table} where id = $1`, [id])).rows[0].c);

  it("copies values to fields with the same label and type", async () => {
    const lead = await insertLead(rep.id, org, { custom_fields: JSON.stringify({ budget: 5000, area: "מכירות", meet: "2026-11-01", notes: "חם" }) });
    const { contact_id, deal_id } = await convert(lead);
    expect(await customOf("contacts", contact_id)).toEqual({ c_budget: 5000 });
    expect(await customOf("deals", deal_id)).toEqual({ d_area: "מכירות" });
  });

  it("a select value the target does not offer is not copied", async () => {
    const lead = await insertLead(rep.id, org, { custom_fields: JSON.stringify({ area: "שיווק" }) });
    const { deal_id } = await convert(lead);
    expect(await customOf("deals", deal_id)).toEqual({});
  });

  it("a lead without custom fields converts as before", async () => {
    const lead = await insertLead(rep.id, org);
    const { contact_id } = await convert(lead);
    expect(await customOf("contacts", contact_id)).toEqual({});
  });
});
