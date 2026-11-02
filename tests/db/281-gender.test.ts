import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { templateVariantProblem } from "@/features/whatsapp/variants";

import cases from "../unit/fixtures/gender-variants.json";
import { addMember, asAdmin, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

/** HEB-01: the optional gender on leads and contacts, and the gender wordings of WhatsApp templates. */
describe("gender (HEB-01)", () => {
  let owner: { id: string };
  let member: { id: string };
  let org: string;

  beforeAll(async () => {
    owner = await createUser("gender-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "gender-member");
  });

  it("the SQL rule answers every fixture case like the TS rule", async () => {
    for (const c of cases as Array<{ text: string; problem: string | null }>) {
      const sql = await asAdmin(async (q) => (await q<{ p: string | null }>("select app.template_variant_problem($1) as p", [c.text])).rows[0].p);
      expect(sql, c.text).toBe(c.problem);
      expect(templateVariantProblem(c.text), c.text).toBe(c.problem);
    }
  });

  it("a person writes the gender of a lead and a contact; another value is refused", async () => {
    const lead = await insertLead(member.id, org, { gender: "female" });
    expect(await asUser(member.id, async (q) => (await q("select gender from public.leads where id = $1", [lead])).rows[0].gender)).toBe("female");
    await asUser(member.id, (q) => q("update public.leads set gender = 'unknown' where id = $1", [lead]));
    expect((await pgError(asUser(member.id, (q) => q("update public.leads set gender = 'other' where id = $1", [lead])))).code).toBe("23514");
    const contact = await asUser(member.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, gender) values ($1, 'דנה', 'male') returning id", [org])).rows[0].id,
    );
    await asUser(member.id, (q) => q("update public.contacts set gender = null where id = $1", [contact]));
    expect(await asAdmin(async (q) => (await q("select gender from public.contacts where id = $1", [contact])).rows[0].gender)).toBeNull();
  });

  it("conversion carries the gender to a new contact", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "רות לוי", gender: "female" });
    const result = await asUser(owner.id, async (q) => (await q<{ r: { contact_id: string } }>("select public.convert_lead($1) as r", [lead])).rows[0].r);
    expect(await asAdmin(async (q) => (await q("select gender from public.contacts where id = $1", [result.contact_id])).rows[0].gender)).toBe("female");
  });

  it("a template with a gender block needs the neutral part, for every writer", async () => {
    const insert = (body: string) =>
      asUser(owner.id, (q) => q("insert into public.whatsapp_templates (organization_id, name, body) values ($1, $2, $3)", [org, `t-${body.length}-${Math.random()}`, body]));
    expect((await pgError(insert("{זכר: אתה | נקבה: את}"))).hint).toBe("whatsapp_template:neutral");
    expect((await pgError(insert("{זכר: אתה | נקבה: את | ניטרלי: אתם"))).hint).toBe("whatsapp_template:variant");
    await insert("שלום {שם פרטי}, {זכר: אתה מוזמן | נקבה: את מוזמנת | ניטרלי: הוזמנת}");
    const id = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.whatsapp_templates where organization_id = $1 and body like '%הוזמנת%'", [org])).rows[0].id);
    expect((await pgError(asUser(owner.id, (q) => q("update public.whatsapp_templates set body = '{נקבה: את}' where id = $1", [id])))).hint).toBe(
      "whatsapp_template:neutral",
    );
    // a server write is judged too
    expect((await pgError(asAdmin((q) => q("update public.whatsapp_templates set body = '{נקבה: את}' where id = $1", [id])))).hint).toBe("whatsapp_template:neutral");
    // a change of another column leaves a stored body alone
    await asUser(owner.id, (q) => q("update public.whatsapp_templates set name = 'מוזמנים' where id = $1", [id]));
  });

  it("the seeded defaults hold no problem", async () => {
    const bodies = await asAdmin(async (q) => (await q<{ p: string | null }>("select app.template_variant_problem(body) as p from public.whatsapp_templates where organization_id = $1", [org])).rows);
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.every((b) => b.p === null)).toBe(true);
  });
});
