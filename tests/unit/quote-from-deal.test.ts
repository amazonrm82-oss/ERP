import { describe, expect, it } from "vitest";

import type { DealLine } from "@/features/deal-lines/queries";
import { fromDealText, lineName, planDealLines } from "@/features/quotes/from-deal";

const base: DealLine = {
  id: "l",
  position: 1,
  productId: null,
  description: "עבודה",
  quantity: 2,
  unitPriceAgorot: 10000,
  discountBp: null,
  discountAgorot: null,
  totalAgorot: 20000,
  priceIncludesVat: false,
  vatExempt: false,
  source: "manual",
  priceListId: null,
  priceListName: null,
  billing: null,
};

const products: Record<string, { offerable: boolean; name: string; description: string | null }> = {
  p1: { offerable: true, name: "מדף", description: "מדף עץ אלון" },
  gone: { offerable: false, name: "מוצר ישן", description: null },
};
const lookup = (id: string) => products[id] ?? null;

// DLI-05 part one: a quote made from its deal's lines copies them as they are
describe("quote from deal lines (DLI-05)", () => {
  it("copies price, quantity, discount, a free line's billing and VAT exemption; a product line takes its description", () => {
    const plan = planDealLines(
      [
        { ...base, id: "a", vatExempt: true, billing: "monthly", discountBp: 1000 },
        { ...base, id: "b", productId: "p1", description: "מדף", source: "price_list", priceListId: "list-1", priceListName: "סיטונאי", unitPriceAgorot: 8000 },
        { ...base, id: "c", productId: "p1", description: "מדף", source: "product" },
      ],
      5,
      lookup,
    );
    expect(plan.skipped).toEqual([]);
    expect(plan.lines.map((l) => l.position)).toEqual([5, 6, 7]);
    expect(plan.lines[0]).toMatchObject({ productId: null, name: "עבודה", quantity: 2, unitPriceAgorot: 10000, discountBp: 1000, vatExempt: true, billing: "monthly", priceSource: "manual", priceListId: null });
    expect(plan.lines[1]).toMatchObject({ productId: "p1", description: "מדף עץ אלון", vatExempt: null, billing: null, priceSource: "price_list", priceListId: "list-1", unitPriceAgorot: 8000 });
    expect(plan.lines[2]).toMatchObject({ priceSource: "product", priceListId: null });
  });

  it("a free line saved before billing existed is one-time; a list price whose list was deleted stays as typed", () => {
    const plan = planDealLines([{ ...base, source: "price_list", priceListId: null, priceListName: "נמחק" }], 1, lookup);
    expect(plan.lines[0]).toMatchObject({ billing: "one_time", priceSource: "manual", priceListId: null });
  });

  it("leaves out a line whose product is no longer offered, and names it", () => {
    const plan = planDealLines([{ ...base, productId: "gone", description: "  " }, { ...base, productId: "missing", description: "שורה ישנה" }, base], 1, lookup);
    expect(plan.skipped).toEqual(["מוצר ישן", "שורה ישנה"]);
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0].position).toBe(1);
  });

  it("a name is the trimmed text cut to 300 characters, else the product's name, else a neutral one", () => {
    expect(lineName(`${" ".repeat(300)}שירות`)).toBe("שירות");
    expect(lineName("א".repeat(400))).toBe("א".repeat(300));
    expect(lineName("   ", "מדף")).toBe("מדף");
    expect(lineName("", null)).toBe("שורה");
  });

  it("says what came from the deal", () => {
    expect(fromDealText(1, 0)).toBe("נוספה שורה אחת מהעסקה.");
    expect(fromDealText(3, 2)).toContain("2 שורות לא הועתקו");
  });
});
