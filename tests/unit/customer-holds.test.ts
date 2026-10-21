import { describe, expect, it } from "vitest";

import { holdReasonSchema, holdWarningText, isActiveHoldClash } from "@/features/customer-holds/schema";
import { dbErrorMessage } from "@/lib/errors";

// COL-05: the warning's wording and the reason rule (answers 2א and 4א).
describe("customer holds (COL-05)", () => {
  it("the warning names whose hold it is, who set it and why", () => {
    expect(holdWarningText({ on: "contact", reason: "חוב מאי", by: "דנה" })).toBe('הלקוח מסומן "לא למכור עד הסדרת חוב" (על ידי דנה): חוב מאי');
    expect(holdWarningText({ on: "company", reason: "חוב", by: null })).toBe('החברה של הלקוח מסומנת "לא למכור עד הסדרת חוב": חוב');
  });

  it("a reason is required, up to 500 characters, trimmed", () => {
    expect(holdReasonSchema.parse("  חוב  ")).toBe("חוב");
    expect(holdReasonSchema.safeParse("   ").success).toBe(false);
    expect(holdReasonSchema.safeParse("x".repeat(501)).success).toBe(false);
    expect(holdReasonSchema.safeParse("x".repeat(500)).success).toBe(true);
  });

  it("a second hold set at the same moment reads as 'already held' (the unique index, not the trigger)", () => {
    const clash = { code: "23505", message: 'duplicate key value violates unique constraint "customer_holds_contact_active"' };
    expect(isActiveHoldClash(clash)).toBe(true);
    expect(isActiveHoldClash({ ...clash, message: 'duplicate key value violates unique constraint "customer_holds_company_active"' })).toBe(true);
    expect(isActiveHoldClash({ ...clash, message: 'duplicate key value violates unique constraint "accounting_documents_number_once"' })).toBe(false);
    expect(isActiveHoldClash({ code: "42501", message: "customer_holds_contact_active" })).toBe(false);
    expect(dbErrorMessage({ code: "P0001", hint: "customer_hold:exists", message: "" })).toBe('הלקוח כבר מסומן "לא למכור עד הסדרת חוב".');
  });
});
