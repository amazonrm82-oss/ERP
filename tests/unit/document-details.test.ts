import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BANK_FIELD_NAMES, bankDetailsSchema, DETAILS_FIELD_NAMES, DOCUMENT_TAX_ID_INVALID, documentDetailsSchema } from "@/features/tax/schema";
import { BANK_COLUMNS, bankDetailsFromRow, bankTransferText, DETAILS_COLUMNS, documentAddress, documentDetailsFromRow } from "@/features/tax/settings";

const empty = Object.fromEntries(DETAILS_FIELD_NAMES.map((name) => [name, ""]));
const parse = (values: Record<string, string>) => documentDetailsSchema.safeParse({ ...empty, ...values });
const emptyBank = Object.fromEntries(BANK_FIELD_NAMES.map((name) => [name, ""]));
const parseBank = (values: Record<string, string>) => bankDetailsSchema.safeParse({ ...emptyBank, ...values });

// TAX-02: the business details printed on documents
describe("business details for documents (TAX-02)", () => {
  it("the form fields are the columns of the migration and of the read", () => {
    const migration = readFileSync(join(process.cwd(), "supabase/migrations/20261006013600_business_documents_details.sql"), "utf8");
    const added = [...migration.matchAll(/add column if not exists ([a-z_]+)/g)].map((m) => m[1]);
    expect(added).toEqual([...DETAILS_FIELD_NAMES]);
    expect(DETAILS_COLUMNS.split(", ")).toEqual([...DETAILS_FIELD_NAMES]);
    // bank details are in their own table, owners and admins only (owner, 13 October 2026)
    expect(added.some((name) => name.startsWith("bank_"))).toBe(false);
    const bank = readFileSync(join(process.cwd(), "supabase/migrations/20261006013800_org_bank_details.sql"), "utf8");
    const bankColumns = [...bank.matchAll(/^  (bank_[a-z_]+)\s+text/gm)].map((m) => m[1]);
    expect(bankColumns).toEqual([...BANK_FIELD_NAMES]);
    expect(BANK_COLUMNS.split(", ")).toEqual([...BANK_FIELD_NAMES]);
  });

  it("everything is optional; empty fields are stored as null", () => {
    const result = parse({});
    expect(result.success).toBe(true);
    expect(Object.values(result.data ?? {}).every((value) => value === null)).toBe(true);
  });

  it("the number is checked like CON-04 and stored as 9 digits", () => {
    expect(parse({ tax_id: "12345678-2" }).data?.tax_id).toBe("123456782");
    expect(parse({ tax_id: "18" }).success).toBe(false);
    expect(parse({ tax_id: "00018" }).data?.tax_id).toBe("000000018");
    const wrong = parse({ tax_id: "123456789" });
    expect(wrong.success).toBe(false);
    expect(wrong.error?.issues[0]?.message).toBe(DOCUMENT_TAX_ID_INVALID);
    expect(parse({ tax_id: "000000000" }).success).toBe(false);
  });

  it("postal code, branch and account keep digits only", () => {
    expect(parse({ postal_code: "61 000 00" }).data?.postal_code).toBe("6100000");
    expect(parse({ postal_code: "61000" }).data?.postal_code).toBe("61000");
    expect(parse({ postal_code: "610000" }).success).toBe(false);
    expect(parseBank({ bank_name: "בנק לאומי", bank_branch: "800", bank_account: "12-345-67" }).data?.bank_account).toBe("1234567");
    expect(parseBank({ bank_branch: "12345" }).success).toBe(false);
  });

  it("an account number needs the bank and the branch", () => {
    const result = parseBank({ bank_account: "1234567" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path[0]).sort()).toEqual(["bank_branch", "bank_name"]);
    expect(parseBank({ bank_name: "בנק הפועלים", bank_branch: "600" }).success).toBe(true);
  });

  it("phone and email follow the usual rules", () => {
    expect(parse({ phone: "03-1234567", email: "Office@Example.co.il" }).data).toMatchObject({ phone: "03-1234567", email: "office@example.co.il" });
    expect(parse({ phone: "call me" }).success).toBe(false);
    expect(parse({ email: "not-an-email" }).success).toBe(false);
  });

  it("address and bank lines for documents", () => {
    const details = documentDetailsFromRow(null);
    expect(documentAddress(details)).toBeNull();
    expect(bankTransferText(bankDetailsFromRow(null))).toBeNull();
    expect(documentAddress({ addressLine: "הרצל 1", city: "תל אביב", postalCode: "6100000" })).toBe("הרצל 1, תל אביב 6100000");
    expect(documentAddress({ addressLine: null, city: "חיפה", postalCode: null })).toBe("חיפה");
    expect(bankTransferText({ bankName: "בנק לאומי", bankBranch: "800", bankAccount: "1234567", bankAccountName: 'דוגמה בע"מ' })).toBe(
      'בנק לאומי, סניף 800, חשבון 1234567, על שם דוגמה בע"מ',
    );
  });
});
