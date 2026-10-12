import { describe, expect, it } from "vitest";

import { companySchema, TAX_ID_INVALID, TAX_ID_INVALID_FOREIGN } from "@/features/companies/schema";
import { foreignCompanyNumber } from "@/features/companies/tax-id";
import { israeliIdNumber } from "@/lib/israeli-id";

// CON-04
describe("Israeli ID and company numbers", () => {
  it("checks the check digit and pads to 9 digits", () => {
    expect(israeliIdNumber("12345674")).toBe("012345674");
    expect(israeliIdNumber(" 51 428562 6 ")).toBe("514285626");
    expect(israeliIdNumber("514285627")).toBeNull();
    expect(israeliIdNumber("1234567890")).toBeNull();
    expect(israeliIdNumber("abc")).toBeNull();
    expect(israeliIdNumber("000000000")).toBeNull();
    expect(israeliIdNumber("00000")).toBeNull();
    expect(israeliIdNumber("000-00-0000")).toBeNull();
  });

  const base = { name: "חברה", industry: "", phone: "", email: "", website: "", city: "", address_line: "" };

  it("the company form stores a valid number as 9 digits and refuses a wrong one", () => {
    const ok = companySchema.safeParse({ ...base, tax_id: "51-428562-6" });
    expect(ok.success && ok.data.tax_id).toBe("514285626");
    const empty = companySchema.safeParse({ ...base, tax_id: "" });
    expect(empty.success && empty.data.tax_id).toBeNull();
    const bad = companySchema.safeParse({ ...base, tax_id: "514285627" });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0].message).toBe(TAX_ID_INVALID);
  });

  // owner's decision, 12 October 2026: abroad only the shape is checked
  it("a foreign number is 2 to 30 Latin letters, digits, spaces, - . /, trimmed and kept as typed", () => {
    expect(foreignCompanyNumber("GB123456")).toBe("GB123456");
    expect(foreignCompanyNumber("  HRB 12345 / B-1.2 ")).toBe("HRB 12345 / B-1.2");
    expect(foreignCompanyNumber("12")).toBe("12");
    expect(foreignCompanyNumber("x".repeat(30))).toBe("x".repeat(30));
    for (const bad of ["1", "", "   ", "x".repeat(31), "GB_123", "AB#12", "שלום12", "Ünï123", "12\t34"]) {
      expect(foreignCompanyNumber(bad), bad).toBeNull();
    }
  });

  it("the company form checks the number by the company's country", () => {
    // no country means Israel, as in the database
    expect(companySchema.safeParse({ ...base, tax_id: "514285626" }).data?.country).toBe("IL");
    const israeliWithLetters = companySchema.safeParse({ ...base, country: "IL", tax_id: "GB123456" });
    expect(israeliWithLetters.error?.issues[0].message).toBe(TAX_ID_INVALID);
    expect(israeliWithLetters.error?.issues[0].path).toEqual(["tax_id"]);

    const foreign = companySchema.safeParse({ ...base, country: "gb", tax_id: " GB 123-45 " });
    expect(foreign.success && foreign.data).toMatchObject({ country: "GB", tax_id: "GB 123-45" });
    // an Israeli number abroad is kept as typed, not padded
    expect(companySchema.safeParse({ ...base, country: "US", tax_id: "12345674" }).data?.tax_id).toBe("12345674");
    expect(companySchema.safeParse({ ...base, country: "US", tax_id: "" }).data?.tax_id).toBeNull();
    const badForeign = companySchema.safeParse({ ...base, country: "DE", tax_id: "HRB#1" });
    expect(badForeign.error?.issues[0].message).toBe(TAX_ID_INVALID_FOREIGN);
    expect(badForeign.error?.issues[0].path).toEqual(["tax_id"]);

    expect(companySchema.safeParse({ ...base, country: "QQ", tax_id: "" }).success).toBe(false);
  });
});
