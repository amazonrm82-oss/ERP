import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

// 9 digits with a valid check digit, and the same number with a wrong one
const VALID = "123456782";
const WRONG = "123456789";

/** TAX-02: the business details printed on documents (more columns of public.org_document_settings). */
describe("business details for documents", () => {
  let owner: { id: string };
  let admin: { id: string };
  let member: { id: string };
  let org: string;

  const set = (userId: string, assignment: string, params: unknown[] = []) =>
    asUser(userId, (q) => q(`update public.org_document_settings set ${assignment} where organization_id = $1 returning id`, [org, ...params]));

  beforeAll(async () => {
    owner = await createUser("docs-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "docs-admin");
    member = await addMember(org, owner.id, "member", "docs-member");
  });

  it("an admin can create the row with the details only, without choosing a VAT status yet", async () => {
    const row = await asUser(admin.id, async (q) =>
      (
        await q<{ legal_name: string; tax_id: string; vat_status: string | null }>(
          "insert into public.org_document_settings (organization_id, legal_name, tax_id) values ($1, 'דוגמה בע\"מ', $2) returning legal_name, tax_id, vat_status",
          [org, VALID],
        )
      ).rows[0],
    );
    expect(row).toEqual({ legal_name: 'דוגמה בע"מ', tax_id: VALID, vat_status: null });
  });

  it("the number must be 9 digits with a valid check digit (the same rule as CON-04)", async () => {
    for (const bad of [WRONG, "12345678", "1234-5678", "000000000", " 123456782", "12345678a"]) {
      expect((await pgError(set(owner.id, "tax_id = $2", [bad]))).code, bad).toBe("23514");
    }
    // the check is app.valid_israeli_id(), so ids that pass CON-04 pass here too (stored padded)
    const padded = "000000018";
    expect(await asAdmin(async (q) => (await q<{ v: boolean }>("select app.valid_israeli_id($1) as v", [padded])).rows[0].v)).toBe(true);
    expect((await set(owner.id, "tax_id = $2", [padded])).rowCount).toBe(1);
    expect((await set(owner.id, "tax_id = null")).rowCount).toBe(1);
  });

  it("address, phone, email and postal code are checked", async () => {
    const good = [
      "address_line = 'הרצל 1', city = 'תל אביב', postal_code = '6100000'",
      "postal_code = '61000'",
      "phone = '03-1234567', email = 'office@example.co.il'",
      "phone = '+972 3 123 4567'",
    ];
    for (const ok of good) {
      expect((await set(owner.id, ok)).rowCount, ok).toBe(1);
    }
    for (const bad of [
      "postal_code = '610000'",
      "postal_code = '61-000'",
      "phone = 'call me'",
      "email = 'not-an-email'",
      // the email is also the ORGANIZER of invite files: no control character, no quote
      "email = E'office\\x01@example.co.il'",
      "email = E'office@example.co.il\\x7f'",
      "email = 'of\"fice@example.co.il'",
      "legal_name = '   '",
      `legal_name = '${"א".repeat(121)}'`,
      "address_line = ''",
      "city = ' '",
    ]) {
      expect((await pgError(set(owner.id, bad))).code, bad).toBe("23514");
    }
  });

  it("the bank details are not in this table (owners and admins only, migration org_bank_details)", async () => {
    const columns = await asAdmin(async (q) =>
      (
        await q<{ column_name: string }>(
          "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'org_document_settings' and column_name like 'bank%'",
        )
      ).rows,
    );
    expect(columns).toEqual([]);
  });

  it("every member reads them (quotes are made by members); only owners and admins change them", async () => {
    const row = await asUser(member.id, async (q) =>
      (await q<{ legal_name: string; postal_code: string }>("select legal_name, postal_code from public.org_document_settings where organization_id = $1", [org])).rows[0],
    );
    expect(row).toEqual({ legal_name: 'דוגמה בע"מ', postal_code: "61000" });
    expect((await set(member.id, "legal_name = 'נפרץ'")).rowCount).toBe(0);
    expect((await set(admin.id, "legal_name = 'דוגמה בע\"מ'")).rowCount).toBe(1);
  });

  it("a read-only organization keeps its details but cannot change them", async () => {
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    expect((await set(owner.id, "city = 'חיפה'")).rowCount).toBe(0);
    await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
  });

  it("changes are audited", async () => {
    const changed = await asAdmin(async (q) =>
      (
        await q<{ n: number }>(
          "select count(*)::int as n from public.audit_log where organization_id = $1 and entity_type = 'org_document_settings' and action = 'update' and changes ? 'postal_code'",
          [org],
        )
      ).rows[0].n,
    );
    expect(changed).toBeGreaterThan(0);
  });
});
