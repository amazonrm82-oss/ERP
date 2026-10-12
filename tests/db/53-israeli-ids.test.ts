import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { foreignCompanyNumber } from "@/features/companies/tax-id";
import { israeliIdNumber } from "@/lib/israeli-id";

import { asAdmin, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

// CON-04: Israeli ID and company numbers have a check digit, checked in the
// database as well as in the forms.
describe("Israeli ID and company numbers (CON-04)", () => {
  let owner: U;
  let org: string;

  beforeAll(async () => {
    owner = await createUser("ilid-owner");
    org = await createOrg(owner.id);
  });

  const valid = (value: string | null) =>
    asAdmin(async (q) => (await q<{ ok: boolean }>("select app.valid_israeli_id($1) as ok", [value])).rows[0].ok);

  it("app.valid_israeli_id agrees with the app's israeliIdNumber", async () => {
    const samples = ["123456782", "123456789", "000000018", "18", "12345", "514285626", "51428562", "999999998", "000000000", "1234567890", "12-34", "", "١٢٣٤٥٦٧٨٢"];
    for (const value of samples) {
      const app = israeliIdNumber(value) !== null && /^[0-9]+$/.test(value);
      expect(await valid(value), value).toBe(app);
    }
    expect(await valid(null)).toBe(false);
    // all zeros passes the check digit but is refused by both
    for (const zeros of ["00000", "0000000", "000000000"]) {
      expect(israeliIdNumber(zeros), zeros).toBeNull();
      expect(await valid(zeros), zeros).toBe(false);
    }
  });

  it("a person can save a company only with a valid number, stored as 9 digits", async () => {
    const insert = (taxId: string) =>
      asUser(owner.id, async (q) =>
        (await q<{ tax_id: string }>("insert into public.companies (organization_id, name, tax_id) values ($1, 'חברה', $2) returning tax_id", [org, taxId])).rows[0].tax_id,
      );
    const error = await pgError(insert("514285627"));
    expect(error.code).toBe("P0001");
    expect(error.hint).toBe("tax_id:invalid");
    expect((await pgError(insert("51-428562-6"))).hint).toBe("tax_id:invalid");
    expect(await insert("514285626")).toBe("514285626");
    expect((await pgError(insert("1234"))).hint).toBe("tax_id:invalid");
    expect(await insert("12345674")).toBe("012345674");
  });

  it("an existing row with an old number can still be changed; a new number is checked", async () => {
    const id = await asAdmin(async (q) =>
      (await q<{ id: string }>("insert into public.companies (organization_id, name, tax_id) values ($1, 'ישנה', 'ע.מ. 123') returning id", [org])).rows[0].id,
    );
    expect(await asUser(owner.id, async (q) => (await q("update public.companies set name = 'ישנה 2', owner_id = $2 where id = $1", [id, owner.id])).rowCount)).toBe(1);
    expect((await pgError(asUser(owner.id, (q) => q("update public.companies set tax_id = '123' where id = $1", [id])))).hint).toBe("tax_id:invalid");
    expect(await asUser(owner.id, async (q) => (await q("update public.companies set tax_id = null where id = $1", [id])).rowCount)).toBe(1);
  });

  // owner's decision, 12 October 2026: abroad only the shape is checked (migration foreign_company_number)
  const insertIn = (country: string | null, taxId: string | null) =>
    asUser(owner.id, async (q) =>
      (
        await q<{ id: string; tax_id: string | null }>(
          "insert into public.companies (organization_id, name, tax_id, country) values ($1, 'Foreign Ltd', $2, coalesce($3, 'IL')) returning id, tax_id",
          [org, taxId, country],
        )
      ).rows[0],
    );

  it("a company outside Israel needs 2 to 30 Latin letters, digits, spaces, - . /, stored trimmed as typed", async () => {
    expect((await insertIn("GB", "GB123456")).tax_id).toBe("GB123456");
    expect((await insertIn("DE", "  HRB 12345 / B-1.2  ")).tax_id).toBe("HRB 12345 / B-1.2");
    expect((await insertIn("US", "12")).tax_id).toBe("12");
    // an Israeli number is not padded or checked abroad
    expect((await insertIn("US", "12345")).tax_id).toBe("12345");
    expect((await insertIn("FR", "x".repeat(30))).tax_id).toBe("x".repeat(30));
    for (const bad of ["1", "x".repeat(31), "GB_123", "ח.פ. 123", "AB#12", "   ", "", "12\t34"]) {
      const error = await pgError(insertIn("GB", bad));
      expect(error.code, bad).toBe("P0001");
      expect(error.hint, bad).toBe("tax_id:invalid_foreign");
    }
  });

  it("the database and the app agree on foreign numbers", async () => {
    const samples = ["GB123456", " AB-1 ", "1", "a/b.c d-e", "ABC_1", "שלום12", "x".repeat(30), "x".repeat(31), "Ünï123"];
    for (const value of samples) {
      const app = foreignCompanyNumber(value);
      const db = await insertIn("GB", value).then(
        (row) => row.tax_id,
        () => null,
      );
      expect(db, value).toBe(app);
    }
  });

  it("an empty number is allowed in Israel and abroad", async () => {
    expect((await insertIn("IL", null)).tax_id).toBeNull();
    expect((await insertIn("GB", null)).tax_id).toBeNull();
  });

  it("changing the country checks the number against the new country", async () => {
    const israeli = await insertIn("IL", "514285626");
    // Israel to abroad with an Israeli number keeps working
    expect(await asUser(owner.id, async (q) => (await q("update public.companies set country = 'GB' where id = $1", [israeli.id])).rowCount)).toBe(1);
    // and back
    expect(await asUser(owner.id, async (q) => (await q("update public.companies set country = 'IL' where id = $1", [israeli.id])).rowCount)).toBe(1);

    const foreign = await insertIn("GB", "GB123456");
    expect((await pgError(asUser(owner.id, (q) => q("update public.companies set country = 'IL' where id = $1", [foreign.id])))).hint).toBe("tax_id:invalid");
    // country and number together, as the form sends them
    const both = await asUser(owner.id, async (q) =>
      (await q<{ tax_id: string }>("update public.companies set country = 'IL', tax_id = '12345674' where id = $1 returning tax_id", [foreign.id])).rows[0].tax_id,
    );
    expect(both).toBe("012345674");
    expect((await pgError(asUser(owner.id, (q) => q("update public.companies set country = 'GB', tax_id = 'GB#1' where id = $1", [foreign.id])))).hint).toBe("tax_id:invalid_foreign");
  });

  it("a foreign row with an old number that does not fit can still be changed", async () => {
    const id = await asAdmin(async (q) =>
      (await q<{ id: string }>("insert into public.companies (organization_id, name, tax_id, country) values ($1, 'Old Ltd', 'ע.מ. #1', 'GB') returning id", [org])).rows[0].id,
    );
    expect(await asUser(owner.id, async (q) => (await q("update public.companies set name = 'Old Ltd 2' where id = $1", [id])).rowCount)).toBe(1);
    // the form sends the same country and number back: unchanged, not checked
    expect(await asUser(owner.id, async (q) => (await q("update public.companies set tax_id = 'ע.מ. #1', country = 'GB' where id = $1", [id])).rowCount)).toBe(1);
    expect((await pgError(asUser(owner.id, (q) => q("update public.companies set tax_id = 'ע.מ. #2' where id = $1", [id])))).hint).toBe("tax_id:invalid_foreign");
  });

  it("a country is two capital letters, so a lowercase 'il' cannot skip the Israeli check", async () => {
    for (const country of ["il", "Il", "I", "1L"]) {
      const error = await pgError(insertIn(country, "514285627"));
      expect(error.code, country).toBe("23514");
      expect(error.message, country).toContain("companies_country_code");
    }
    const validated = await asAdmin(async (q) =>
      (await q<{ ok: boolean }>("select convalidated as ok from pg_constraint where conname = 'companies_country_code'")).rows[0].ok,
    );
    expect(validated).toBe(true);
  });

  it("custom fields of type il_id / il_company_id need a valid number", async () => {
    await asUser(owner.id, (q) =>
      q(
        "insert into public.field_definitions (organization_id, object_type, key, label, field_type) values ($1, 'contact', 'tz', 'תעודת זהות', 'il_id'), ($1, 'company', 'hp', 'ח.פ.', 'il_company_id')",
        [org],
      ),
    );
    const contact = (value: string) =>
      asUser(owner.id, (q) =>
        q("insert into public.contacts (organization_id, first_name, custom_fields) values ($1, 'דנה', jsonb_build_object('tz', $2::text))", [org, value]),
      );
    expect((await pgError(contact("123456789"))).hint).toBe("custom_field:invalid");
    await contact("123456782");
    const company = (value: string) =>
      asUser(owner.id, (q) =>
        q("insert into public.companies (organization_id, name, custom_fields) values ($1, 'חברה', jsonb_build_object('hp', $2::text))", [org, value]),
      );
    expect((await pgError(company("514285627"))).hint).toBe("custom_field:invalid");
    await company("514285626");
  });
});
