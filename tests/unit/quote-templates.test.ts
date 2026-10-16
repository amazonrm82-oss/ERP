import { describe, expect, it } from "vitest";

import { appliedText, planTemplateLines, type QuoteTemplateLine } from "@/features/quotes/templates";

const line = (extra: Partial<QuoteTemplateLine>): QuoteTemplateLine => ({
  kind: "item",
  productId: null,
  name: "שורה",
  description: null,
  quantity: 1,
  unitPriceAgorot: 1000,
  discountBp: null,
  discountAgorot: null,
  vatExempt: false,
  billing: "one_time",
  isOptional: false,
  optionalSelected: false,
  ...extra,
});

describe("using a quote template (QUO-04)", () => {
  const offerable = (id: string) => id !== "archived";
  const automatic = (id: string, quantity: number) => (id === "unpriced" ? null : { agorot: 500 * quantity, source: "price_list" as const, listId: "list" });

  it("keeps the order after the quote's last line, prices catalog lines for this quote and keeps typed prices", () => {
    const plan = planTemplateLines(
      [
        line({ kind: "group", name: "שלב א", unitPriceAgorot: null }),
        line({ productId: "p1", unitPriceAgorot: null, quantity: 2 }),
        line({ productId: "p2", unitPriceAgorot: 777 }),
        line({ name: "חופשית", unitPriceAgorot: 1200, isOptional: true, optionalSelected: true }),
      ],
      5,
      offerable,
      automatic,
    );
    expect(plan.skipped).toBe(0);
    expect(plan.lines.map((l) => [l.position, l.kind, l.price])).toEqual([
      [5, "group", { agorot: 0, source: "manual", listId: null }],
      [6, "item", { agorot: 1000, source: "price_list", listId: "list" }],
      [7, "item", { agorot: 777, source: "manual", listId: null }],
      [8, "item", { agorot: 1200, source: "manual", listId: null }],
    ]);
    expect(plan.lines[3]).toMatchObject({ isOptional: true, optionalSelected: true });
  });

  it("skips a product that is no longer offered or cannot be priced, and a free line with no price", () => {
    const plan = planTemplateLines(
      [line({ productId: "archived", unitPriceAgorot: 100 }), line({ productId: "unpriced", unitPriceAgorot: null }), line({ unitPriceAgorot: null }), line({})],
      1,
      offerable,
      automatic,
    );
    expect(plan.skipped).toBe(3);
    expect(plan.lines.map((l) => l.position)).toEqual([1]);
  });

  it("says what was added and what was skipped", () => {
    expect(appliedText(1, 0)).toBe("נוספה שורה אחת מהתבנית.");
    expect(appliedText(4, 0)).toBe("נוספו 4 שורות מהתבנית.");
    expect(appliedText(4, 1)).toBe("נוספו 4 שורות מהתבנית. שורה אחת דולגה, כי המוצר שלה כבר לא פעיל.");
    expect(appliedText(2, 3)).toBe("נוספו 2 שורות מהתבנית. 3 שורות דולגו, כי המוצרים שלהן כבר לא פעילים.");
  });
});
