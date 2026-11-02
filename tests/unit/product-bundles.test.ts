import { readdirSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BUNDLE_DISPLAYS, BUNDLE_PARTS_MAX, parseBundleItems, partQuantity, partsReferenceSum } from "@/features/products/bundle";
import { BundleItemsList } from "@/features/products/components/bundle-items-list";

const migrationFile = readdirSync("supabase/migrations").find((f) => f.endsWith("_product_bundles.sql")) as string;
const migration = readFileSync(`supabase/migrations/${migrationFile}`, "utf8");

// PRD-09: the pure parts of bundles
describe("bundles (PRD-09)", () => {
  it("the display choices and the parts limit match the migration", () => {
    expect(migration).toContain(`check (bundle_display in (${BUNDLE_DISPLAYS.map((d) => `'${d}'`).join(", ")}))`);
    expect(migration).toContain(`>= ${BUNDLE_PARTS_MAX} then`);
  });

  it("reads the parts a line keeps, skipping anything else", () => {
    expect(parseBundleItems(null)).toEqual([]);
    expect(parseBundleItems({ name: "x" })).toEqual([]);
    expect(
      parseBundleItems([{ name: "מזגן", quantity: 2, unit_name: "יחידה" }, { name: "צינור", quantity: "1.5", unit_name: null }, { quantity: 1 }, { name: "אפס", quantity: 0 }, "x"]),
    ).toEqual([
      { name: "מזגן", quantity: 2, unitName: "יחידה" },
      { name: "צינור", quantity: 1.5, unitName: null },
    ]);
  });

  it("a part's quantity on a line is per bundle times the line's quantity, to three decimals", () => {
    expect(partQuantity(2, 3)).toBe(6);
    expect(partQuantity(1.5, 0.5)).toBe(0.75);
    expect(partQuantity(0.333, 3)).toBe(0.999);
    expect(partQuantity(0.125, 0.125)).toBe(0.016);
  });

  it("the parts' reference sum takes each price into the bundle's mode, half up", () => {
    const taxable = (priceAgorot: number, priceIncludesVat = false) => ({ priceAgorot, priceIncludesVat, vatKind: "taxable" as const });
    // before VAT: 2 x 100.00 + 1.5 x 33.33 = 200.00 + 49.995 -> 50.00
    expect(partsReferenceSum([{ quantity: 2, price: taxable(10000) }, { quantity: 1.5, price: taxable(3333) }], false, 1800)).toBe(25000);
    // a price typed with VAT, shown before VAT: 118.00 -> 100.00
    expect(partsReferenceSum([{ quantity: 1, price: taxable(11800, true) }], false, 1800)).toBe(10000);
    // into a bundle priced with VAT: 100.00 -> 118.00; an exempt part keeps its price
    expect(partsReferenceSum([{ quantity: 1, price: taxable(10000) }, { quantity: 1, price: { priceAgorot: 500, priceIncludesVat: false, vatKind: "exempt" } }], true, 1800)).toBe(
      12300,
    );
    expect(partsReferenceSum([], false, 1800)).toBe(0);
  });

  it("the list under a line shows names and quantities, never prices", () => {
    const html = renderToStaticMarkup(createElement(BundleItemsList, { parts: [{ name: "מזגן", quantity: 2, unitName: "יחידה" }], lineQuantity: 2 }));
    expect(html).toContain("מזגן");
    expect(html).toContain(">4<");
    expect(html).toContain("יחידה");
    expect(html).not.toContain("₪");
    expect(renderToStaticMarkup(createElement(BundleItemsList, { parts: [], lineQuantity: 1 }))).toBe("");
  });
});
