import { describe, expect, it } from "vitest";

import { parentCompanySchema } from "@/features/companies/schema";
import { dbErrorMessage } from "@/lib/errors";

// CON-07: the parent company field and the messages of the database guard.
describe("company hierarchy (CON-07)", () => {
  it("an empty pick means no parent; a uuid is kept; anything else is refused", () => {
    expect(parentCompanySchema.parse({ parent_company_id: "" })).toEqual({ parent_company_id: null });
    const id = "3f1c2b7e-8d4a-4f6b-9a1e-2c3d4e5f6a7b";
    expect(parentCompanySchema.parse({ parent_company_id: id })).toEqual({ parent_company_id: id });
    expect(parentCompanySchema.safeParse({ parent_company_id: "not-an-id" }).success).toBe(false);
  });

  it("each guard hint has its own Hebrew message", () => {
    const messages = ["company:parent_invalid", "company:parent_cycle", "company:parent_depth"].map((hint) =>
      dbErrorMessage({ code: "P0001", hint, message: "x" }, "fallback"),
    );
    for (const message of messages) {
      expect(message).not.toBe("fallback");
      expect(message).toMatch(/[֐-׿]/);
    }
    expect(new Set(messages).size).toBe(3);
    expect(messages[2]).toContain("10");
  });
});
