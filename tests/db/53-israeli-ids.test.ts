import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

  it("a company outside Israel is not checked", async () => {
    const taxId = await asUser(owner.id, async (q) =>
      (await q<{ tax_id: string }>("insert into public.companies (organization_id, name, tax_id, country) values ($1, 'Foreign Ltd', 'GB123456', 'GB') returning tax_id", [org])).rows[0].tax_id,
    );
    expect(taxId).toBe("GB123456");
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
