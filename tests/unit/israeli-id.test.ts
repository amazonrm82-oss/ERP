import { describe, expect, it } from "vitest";

import { companySchema, TAX_ID_INVALID } from "@/features/companies/schema";
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
});
