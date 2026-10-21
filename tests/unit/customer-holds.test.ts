import { describe, expect, it } from "vitest";

import { holdReasonSchema, holdWarningText } from "@/features/customer-holds/schema";

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
});
