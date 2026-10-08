import { describe, expect, it } from "vitest";

import { normalize } from "@/features/intake/server";

describe("intake: the fields of a form post (FXS-02)", () => {
  it("reads the fields under the names other systems use", () => {
    expect(normalize({ name: " דנה ", tel: "050-1234567", mail: "d@x.co", company: "אלון", notes: "שלום" })).toEqual({
      full_name: "דנה",
      phone: "050-1234567",
      email: "d@x.co",
      company_name: "אלון",
      message: "שלום",
    });
    expect(normalize({ first_name: "דנה", last_name: "כהן" }).full_name).toBe("דנה כהן");
  });

  it("cuts each field to the length the lead keeps", () => {
    const out = normalize({ full_name: "א".repeat(500), phone: "1".repeat(100), email: `${"e".repeat(300)}@x.co`, company_name: "ב".repeat(300), message: "ג".repeat(9000) });
    expect(out.full_name).toHaveLength(200);
    expect(out.phone).toHaveLength(40);
    expect(out.email).toHaveLength(254);
    expect(out.company_name).toHaveLength(200);
    expect(out.message).toHaveLength(5000);
  });
});
