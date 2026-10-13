import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

// CON-08: billing details on companies and contacts (nullable columns, the record's own rights),
// with a price list by composite foreign key that is cleared when the list is deleted.
describe("billing details (CON-08)", () => {
  let owner: U, member: U, viewer: U, otherOwner: U;
  let org: string, otherOrg: string;
  let list: string, otherList: string;

  const newPriceList = (userId: string, o: string, name: string) =>
    asUser(userId, async (q) => (await q<{ id: string }>("insert into public.price_lists (organization_id, name) values ($1, $2) returning id", [o, name])).rows[0].id);
  const newCompany = (userId: string, o: string, name: string) =>
    asUser(userId, async (q) => (await q<{ id: string }>("insert into public.companies (organization_id, name) values ($1, $2) returning id", [o, name])).rows[0].id);
  const newContact = (userId: string, o: string, name: string) =>
    asUser(userId, async (q) => (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, $2) returning id", [o, name])).rows[0].id);
  const update = (userId: string, table: "companies" | "contacts", id: string, values: Record<string, unknown>) =>
    asUser(userId, async (q) => {
      const keys = Object.keys(values);
      const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
      return (await q(`update public.${table} set ${sets} where id = $1 returning id`, [id, ...keys.map((k) => values[k])])).rowCount;
    });
  const read = (table: "companies" | "contacts", id: string) =>
    asAdmin(async (q) => (await q<Record<string, unknown>>(`select * from public.${table} where id = $1`, [id])).rows[0]);

  beforeAll(async () => {
    owner = await createUser("bill-owner");
    otherOwner = await createUser("bill-other");
    org = await createOrg(owner.id);
    otherOrg = await createOrg(otherOwner.id, "עסק אחר");
    member = await addMember(org, owner.id, "member", "bill-member");
    viewer = await addMember(org, owner.id, "viewer", "bill-viewer");
    for (const o of [org, otherOrg]) {
      await asAdmin((q) =>
        q("update public.subscriptions set limit_overrides = $2, feature_overrides = $3 where organization_id = $1", [
          o,
          JSON.stringify({ max_price_lists: 10 }),
          JSON.stringify({ price_lists: true }),
        ]),
      );
    }
    list = await newPriceList(owner.id, org, "סיטונאים");
    otherList = await newPriceList(otherOwner.id, otherOrg, "של עסק אחר");
  });

  it("a member stores billing details on their own company and contact, and a price list", async () => {
    const company = await newCompany(member.id, org, "אקמה");
    const contact = await newContact(member.id, org, "דנה");
    expect(
      await update(member.id, "companies", company, {
        billing_name: "אקמה בע\"מ",
        billing_address: "הרצל 1, תל אביב",
        shipping_address: "המחסן 5, חולון",
        billing_email: "billing@acme.co.il",
        payment_terms: "eom",
        payment_days: 30,
        price_list_id: list,
      }),
    ).toBe(1);
    expect(
      await update(member.id, "contacts", contact, {
        billing_name: "דנה כהן",
        billing_tax_id: "123456782",
        billing_email: "dana@example.com",
        payment_terms: "immediate",
        price_list_id: list,
      }),
    ).toBe(1);
    expect(await read("companies", company)).toMatchObject({ payment_terms: "eom", payment_days: 30, price_list_id: list, billing_email: "billing@acme.co.il" });
    expect(await read("contacts", contact)).toMatchObject({ billing_tax_id: "123456782", payment_terms: "immediate", payment_days: null, price_list_id: list });
  });

  it("a contact may be created with billing details (column grants for insert)", async () => {
    const id = await asUser(member.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.contacts (organization_id, first_name, billing_name, billing_tax_id, billing_address, shipping_address, billing_email, payment_terms, payment_days, price_list_id) values ($1, 'יוסי', 'יוסי בע\"מ', '000000018', 'א', 'ב', 'y@example.com', 'net', 45, $2) returning id",
          [org, list],
        )
      ).rows[0].id,
    );
    expect(await read("contacts", id)).toMatchObject({ billing_tax_id: "000000018", payment_terms: "net", payment_days: 45 });
  });

  it("payment terms must have their shape", async () => {
    const company = await newCompany(owner.id, org, "תנאים");
    const contact = await newContact(owner.id, org, "תנאים");
    for (const [table, id] of [["companies", company], ["contacts", contact]] as const) {
      expect((await pgError(update(owner.id, table, id, { payment_terms: "net", payment_days: null }))).code).toBe("23514");
      expect((await pgError(update(owner.id, table, id, { payment_terms: "net", payment_days: 366 }))).code).toBe("23514");
      expect((await pgError(update(owner.id, table, id, { payment_terms: "eom", payment_days: -1 }))).code).toBe("23514");
      expect((await pgError(update(owner.id, table, id, { payment_terms: "immediate", payment_days: 30 }))).code).toBe("23514");
      expect((await pgError(update(owner.id, table, id, { payment_terms: null, payment_days: 30 }))).code).toBe("23514");
      expect((await pgError(update(owner.id, table, id, { payment_terms: "weekly", payment_days: 7 }))).code).toBe("23514");
      expect(await update(owner.id, table, id, { payment_terms: "eom", payment_days: 0 })).toBe(1);
      expect(await update(owner.id, table, id, { payment_terms: "net", payment_days: 365 })).toBe(1);
    }
  });

  it("refuses untrimmed or too long text and a malformed email", async () => {
    const company = await newCompany(owner.id, org, "טקסט");
    const contact = await newContact(owner.id, org, "טקסט");
    for (const [table, id] of [["companies", company], ["contacts", contact]] as const) {
      expect((await pgError(update(owner.id, table, id, { billing_name: " רווח " }))).code).toBe("23514");
      expect((await pgError(update(owner.id, table, id, { billing_name: "" }))).code).toBe("23514");
      expect((await pgError(update(owner.id, table, id, { billing_name: "א".repeat(201) }))).code).toBe("23514");
      expect((await pgError(update(owner.id, table, id, { billing_address: "א".repeat(301) }))).code).toBe("23514");
      expect((await pgError(update(owner.id, table, id, { shipping_address: " " }))).code).toBe("23514");
      expect((await pgError(update(owner.id, table, id, { billing_email: "no-at-sign" }))).code).toBe("23514");
      expect(await update(owner.id, table, id, { billing_name: "א".repeat(200), billing_address: "ב".repeat(300) })).toBe(1);
    }
  });

  it("a contact's number needs 9 digits with a valid check digit", async () => {
    const contact = await newContact(owner.id, org, "מספר");
    expect((await pgError(update(owner.id, "contacts", contact, { billing_tax_id: "123456789" }))).code).toBe("23514");
    // the app pads shorter numbers; the database stores only 9 digits
    expect((await pgError(update(owner.id, "contacts", contact, { billing_tax_id: "18" }))).code).toBe("23514");
    expect((await pgError(update(owner.id, "contacts", contact, { billing_tax_id: "12345678-2" }))).code).toBe("23514");
    expect((await pgError(update(owner.id, "contacts", contact, { billing_tax_id: "000000000" }))).code).toBe("23514");
    expect(await update(owner.id, "contacts", contact, { billing_tax_id: "123456782" })).toBe(1);
  });

  it("a price list of another business cannot be set (composite foreign key)", async () => {
    const company = await newCompany(owner.id, org, "זר");
    const contact = await newContact(owner.id, org, "זר");
    expect((await pgError(update(owner.id, "companies", company, { price_list_id: otherList }))).code).toBe("23503");
    expect((await pgError(update(owner.id, "contacts", contact, { price_list_id: otherList }))).code).toBe("23503");
    // also not by the server
    expect((await pgError(asAdmin((q) => q("update public.contacts set price_list_id = $2 where id = $1", [contact, otherList])))).code).toBe("23503");
  });

  it("deleting a price list clears it on companies and contacts and keeps everything else", async () => {
    const temp = await newPriceList(owner.id, org, "זמני");
    const company = await newCompany(owner.id, org, "מחירון נמחק");
    const contact = await newContact(owner.id, org, "מחירון נמחק");
    await update(owner.id, "companies", company, { price_list_id: temp, billing_name: "נשאר" });
    await update(owner.id, "contacts", contact, { price_list_id: temp, billing_email: "stay@example.com" });
    await asUser(owner.id, (q) => q("delete from public.price_lists where id = $1", [temp]));
    expect(await read("companies", company)).toMatchObject({ price_list_id: null, billing_name: "נשאר", organization_id: org });
    expect(await read("contacts", contact)).toMatchObject({ price_list_id: null, billing_email: "stay@example.com", organization_id: org });
  });

  it("follows the record's rights: a viewer, a member on another's record and an outsider change nothing", async () => {
    const company = await newCompany(owner.id, org, "של הבעלים");
    const contact = await newContact(owner.id, org, "של הבעלים");
    expect(await update(viewer.id, "companies", company, { billing_name: "לא" })).toBe(0);
    expect(await update(viewer.id, "contacts", contact, { billing_name: "לא" })).toBe(0);
    expect(await update(member.id, "companies", company, { billing_name: "לא" })).toBe(0);
    expect(await update(member.id, "contacts", contact, { billing_name: "לא" })).toBe(0);
    expect(await update(otherOwner.id, "companies", company, { billing_name: "לא" })).toBe(0);
    expect(await update(otherOwner.id, "contacts", contact, { billing_name: "לא" })).toBe(0);
    expect((await read("companies", company)).billing_name).toBeNull();
    expect((await read("contacts", contact)).billing_name).toBeNull();
    // an outsider does not read them either
    expect(
      await asUser(otherOwner.id, async (q) => (await q("select billing_name from public.contacts where id = $1", [contact])).rowCount),
    ).toBe(0);
  });

  it("changes are written to the audit log of the record", async () => {
    const contact = await newContact(owner.id, org, "יומן");
    await update(owner.id, "contacts", contact, { billing_email: "audit@example.com", payment_terms: "eom", payment_days: 60 });
    const changes = await asAdmin(async (q) =>
      (
        await q<{ changes: Record<string, unknown> }>(
          "select changes from public.audit_log where organization_id = $1 and entity_id = $2 and action = 'update' order by created_at desc limit 1",
          [org, contact],
        )
      ).rows[0]?.changes,
    );
    expect(JSON.stringify(changes)).toContain("audit@example.com");
    expect(JSON.stringify(changes)).toContain("payment_days");
  });

  it("the columns carry no client grant beyond insert and update of the new columns on contacts", async () => {
    const grants = await asAdmin(async (q) =>
      (
        await q<{ column_name: string; privilege_type: string }>(
          `select column_name, privilege_type from information_schema.column_privileges
            where table_schema = 'public' and table_name = 'contacts' and grantee = 'anon'
              and column_name in ('billing_name', 'billing_tax_id', 'price_list_id')`,
        )
      ).rows,
    );
    expect(grants).toEqual([]);
  });
});
