import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

// CON-02: contact and company types from the organization's own list.
describe("contact and company types (CON-02)", () => {
  let owner: U, member: U;
  let org: string;
  let supplier: string, partner: string, companyCustomer: string, hidden: string;

  const addType = (object: "contact" | "company", name: string, active = true) =>
    asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>("insert into public.record_type_options (organization_id, object_type, name, is_active) values ($1, $2, $3, $4) returning id", [
          org,
          object,
          name,
          active,
        ])
      ).rows[0].id,
    );
  const newContact = (user: U, typeId: string | null) =>
    asUser(user.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, type_id) values ($1, 'דנה', $2) returning id", [org, typeId])).rows[0].id,
    );
  const typeOf = (table: string, id: string) =>
    asAdmin(async (q) => (await q<{ type_id: string | null }>(`select type_id from public.${table} where id = $1`, [id])).rows[0].type_id);

  beforeAll(async () => {
    owner = await createUser("rt-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "rt-member");
    supplier = await addType("contact", "ספק");
    partner = await addType("contact", "שותף");
    hidden = await addType("contact", "ישן", false);
    companyCustomer = await addType("company", "לקוח");
  });

  it("a person picks an active type of the same object type", async () => {
    const contact = await newContact(member, supplier);
    expect(await typeOf("contacts", contact)).toBe(supplier);
    expect((await pgError(newContact(member, hidden))).hint).toBe("record_type:invalid");
    // a company type on a contact
    expect((await pgError(newContact(member, companyCustomer))).hint).toBe("record_type:invalid");
    const company = await asUser(member.id, async (q) =>
      (await q<{ id: string }>("insert into public.companies (organization_id, name, type_id) values ($1, 'חברה', $2) returning id", [org, companyCustomer])).rows[0].id,
    );
    expect(await typeOf("companies", company)).toBe(companyCustomer);
    expect(
      (await pgError(asUser(member.id, (q) => q("update public.companies set type_id = $2 where id = $1", [company, supplier])))).hint,
    ).toBe("record_type:invalid");
  });

  it("a type of another organization fails the composite foreign key", async () => {
    const other = await createUser("rt-other");
    const otherOrg = await createOrg(other.id, "עסק אחר");
    const foreign = await asUser(other.id, async (q) =>
      (await q<{ id: string }>("insert into public.record_type_options (organization_id, object_type, name) values ($1, 'contact', 'ספק') returning id", [otherOrg])).rows[0].id,
    );
    // checked by the trigger first, and by the foreign key for server writes
    expect((await pgError(newContact(member, foreign))).hint).toBe("record_type:invalid");
    const error = await pgError(asAdmin((q) => q("insert into public.contacts (organization_id, first_name, type_id) values ($1, 'x', $2)", [org, foreign])));
    expect(error.code).toBe("23503");
  });

  it("a record keeps a type hidden later; deleting a type leaves its records without one", async () => {
    const contact = await newContact(member, partner);
    await asUser(owner.id, (q) => q("update public.record_type_options set is_active = false where id = $1", [partner]));
    expect(await asUser(member.id, async (q) => (await q("update public.contacts set first_name = 'דנה ב' where id = $1", [contact])).rowCount)).toBe(1);
    expect(await typeOf("contacts", contact)).toBe(partner);
    expect(await asUser(owner.id, async (q) => (await q("delete from public.record_type_options where id = $1", [partner])).rowCount)).toBe(1);
    expect(await typeOf("contacts", contact)).toBeNull();
  });

  it("organization and object type of a type cannot change", async () => {
    const error = await pgError(asUser(owner.id, (q) => q("update public.record_type_options set object_type = 'company' where id = $1", [supplier])));
    expect(error.code).toBe("42501");
  });

  it("names are unique per organization and object type, ignoring case; at most 50 each", async () => {
    expect((await pgError(addType("contact", "ספק"))).code).toBe("23505");
    // the same name for companies is fine
    await addType("company", "ספק");
    expect((await pgError(addType("contact", " רווח "))).code).toBe("23514");
    await asUser(owner.id, (q) =>
      q("insert into public.record_type_options (organization_id, object_type, name) select $1, 'company', 'סוג ' || g from generate_series(1, 48) g", [org]),
    );
    const error = await pgError(addType("company", "עוד אחד"));
    expect(error.code).toBe("P0001");
    expect(error.hint).toBe("record_types:max");
    // contacts have their own 50
    await addType("contact", "עוד אחד");
  });

  it("the lists sort by the type's position", async () => {
    const position = await asUser(member.id, async (q) =>
      (await q<{ p: number | null }>("select public.sort_type(c) as p from public.contacts c where c.organization_id = $1 and c.type_id = $2 limit 1", [org, supplier])).rows[0].p,
    );
    expect(position).toBe(0);
  });

  it("a change to the list is written to the audit log", async () => {
    const id = await addType("contact", "מתחרה");
    const entries = await asAdmin(async (q) =>
      (await q<{ action: string }>("select action from public.audit_log where entity_type = 'record_type_options' and entity_id = $1", [id])).rows,
    );
    expect(entries.map((e) => e.action)).toEqual(["insert"]);
  });
});
