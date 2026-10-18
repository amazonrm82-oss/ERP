import { describe, expect, it } from "vitest";

import { canViewCosts } from "@/features/permissions/keys";
import { costForQuantity, costMeaning, linesProfit, marginText, profitOf } from "@/features/product-costs/margin";
import { PRODUCT_COST_HEADER, PRODUCT_EXPORT_HEADER, productExportHeader, productExportRows } from "@/features/products/export-table";

describe("who sees costs (PRD-06, the rule of app.can_view_costs)", () => {
  it("owners, admins and managers by role; a member or manager only with the grant; never a viewer", () => {
    for (const role of ["owner", "admin", "manager"] as const) expect(canViewCosts(role, []), role).toBe(true);
    expect(canViewCosts("member", [])).toBe(false);
    expect(canViewCosts("member", ["edit_catalog"])).toBe(false);
    expect(canViewCosts("member", ["view_costs"])).toBe(true);
    expect(canViewCosts("viewer", ["view_costs"])).toBe(false);
    expect(canViewCosts(null, ["view_costs"])).toBe(false);
  });
});

describe("profit and margin", () => {
  it("is the net price less the cost, with the margin of the net price, half up", () => {
    expect(profitOf(10000, 6000)).toEqual({ profitAgorot: 4000, marginBp: 4000 });
    expect(profitOf(30000, 10000)).toEqual({ profitAgorot: 20000, marginBp: 6667 });
    // a loss rounds away from zero too
    expect(profitOf(30000, 50000)).toEqual({ profitAgorot: -20000, marginBp: -6667 });
    expect(profitOf(0, 500)).toEqual({ profitAgorot: -500, marginBp: null });
  });

  it("costs a quantity of up to three decimals, half up to the agora", () => {
    expect(costForQuantity(3, 1250)).toBe(3750);
    expect(costForQuantity(1.5, 333)).toBe(500); // 499.5
    expect(costForQuantity(0.001, 1)).toBe(0);
    expect(costForQuantity(2.125, 1000)).toBe(2125);
    expect(() => costForQuantity(-1, 100)).toThrow(RangeError);
    expect(() => costForQuantity(1, -1)).toThrow(RangeError);
  });

  it("adds up the lines that have a cost and counts the rest as left out, never as zero cost", () => {
    // each line's own cost (PRD-06 follow-up: kept on the line when it was made)
    const result = linesProfit([
      { unitCostAgorot: 6000, quantity: 3, netAgorot: 27000 },
      { unitCostAgorot: 30000, quantity: 1, netAgorot: 50000 },
      { unitCostAgorot: null, quantity: 1, netAgorot: 9000 },
      { unitCostAgorot: null, quantity: 1, netAgorot: 5000 },
    ]);
    expect(result).toEqual({ revenueAgorot: 77000, costAgorot: 48000, profitAgorot: 29000, marginBp: 3766, uncosted: 2 });
    expect(linesProfit([{ unitCostAgorot: null, quantity: 1, netAgorot: 9000 }])).toBeNull();
    expect(linesProfit([{ unitCostAgorot: 6000, quantity: 1, netAgorot: null }])).toBeNull();
    // a cost of 0 is a cost, not a missing one
    expect(linesProfit([{ unitCostAgorot: 0, quantity: 2, netAgorot: 1000 }])).toMatchObject({ costAgorot: 0, profitAgorot: 1000, uncosted: 0 });
  });

  it("shows the margin as a short percent", () => {
    expect(marginText(4000)).toBe("40%");
    expect(marginText(3766)).toBe("37.7%");
    expect(marginText(-6667)).toBe("-66.7%");
    expect(marginText(1250)).toBe("12.5%");
  });

  it("says what the cost means for the business's VAT status", () => {
    expect(costMeaning(true)).toBe('העלות ליחידה, לפני מע"מ.');
    expect(costMeaning(null)).toBe('העלות ליחידה, לפני מע"מ.');
    expect(costMeaning(false)).toBe("העלות ליחידה, כפי ששולמה.");
  });
});

describe("the product export and the cost column", () => {
  const product = {
    id: "p1",
    name: "כיסא",
    description: null,
    sku: null,
    categoryId: null,
    kind: "product" as const,
    unitId: null,
    priceAgorot: 10000,
    priceIncludesVat: false,
    vatKind: "taxable" as const,
    billing: "one_time" as const,
    durationMinutes: null,
    barcode: null,
    isActive: true,
    archivedAt: null,
  };

  it("has no cost column for someone who does not see costs", () => {
    expect(productExportHeader(false)).toEqual([...PRODUCT_EXPORT_HEADER]);
    // the header itself leaves the column out, not only the values
    expect(productExportHeader(false)).not.toContain(PRODUCT_COST_HEADER);
    expect(PRODUCT_EXPORT_HEADER as readonly string[]).not.toContain(PRODUCT_COST_HEADER);
    const [row] = productExportRows([product], [], []);
    expect(row).toHaveLength(PRODUCT_EXPORT_HEADER.length);
  });

  it("adds the cost per unit last for someone who does, empty when the product has none", () => {
    expect(productExportHeader(true)).toEqual([...PRODUCT_EXPORT_HEADER, PRODUCT_COST_HEADER]);
    const [withCost] = productExportRows([product], [], [], new Map([["p1", 6050]]));
    expect(withCost.at(-1)).toBe("60.50");
    const [without] = productExportRows([product], [], [], new Map());
    expect(without).toHaveLength(PRODUCT_EXPORT_HEADER.length + 1);
    expect(without.at(-1)).toBe("");
  });
});
