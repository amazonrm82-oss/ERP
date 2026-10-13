import { describe, expect, it } from "vitest";

import { productPriceFor } from "@/features/products/price";
import { copyName, isOfferable, productSchema } from "@/features/products/schema";

describe("a product's price on a document line (PRD-01, TAX-04)", () => {
  const taxable = (priceAgorot: number, priceIncludesVat: boolean) => ({ priceAgorot, priceIncludesVat, vatKind: "taxable" as const });

  it("keeps the number when the modes agree", () => {
    expect(productPriceFor(taxable(10000, false), false, 1800)).toBe(10000);
    expect(productPriceFor(taxable(11800, true), true, 1800)).toBe(11800);
  });

  it("adds or takes out VAT at the document's rate, half up", () => {
    expect(productPriceFor(taxable(10000, false), true, 1800)).toBe(11800);
    expect(productPriceFor(taxable(11800, true), false, 1800)).toBe(10000);
    // 100.00 including 18%: 84.745… -> 84.75
    expect(productPriceFor(taxable(10000, true), false, 1800)).toBe(8475);
    // 0.01 before 17%: 0.0117 -> 0.01
    expect(productPriceFor(taxable(1, false), true, 1700)).toBe(1);
  });

  it("an exempt or zero-rate product and a business without VAT keep the number", () => {
    expect(productPriceFor({ priceAgorot: 5000, priceIncludesVat: false, vatKind: "exempt" }, true, 1800)).toBe(5000);
    expect(productPriceFor({ priceAgorot: 5000, priceIncludesVat: false, vatKind: "zero_rate" }, true, 1800)).toBe(5000);
    expect(productPriceFor(taxable(5000, false), true, 0)).toBe(5000);
  });

  it("refuses a bad price or rate", () => {
    expect(() => productPriceFor(taxable(-1, false), true, 1800)).toThrow(RangeError);
    expect(() => productPriceFor(taxable(1, false), true, 10001)).toThrow(RangeError);
  });
});

describe("product form and rules (PRD-01, PRD-02)", () => {
  const base = { name: " מחשב ", kind: "product", vat_kind: "taxable", billing: "one_time", price_agorot: "1,250.50", is_active: "on" };

  it("parses a product", () => {
    const parsed = productSchema.parse({ ...base, price_includes_vat: "on", duration_minutes: "", sku: "  A-1 ", category_id: "" });
    expect(parsed).toMatchObject({ name: "מחשב", price_agorot: 125050, price_includes_vat: true, duration_minutes: null, sku: "A-1", category_id: null, is_active: true });
  });

  it("a price including VAT only on a taxable product", () => {
    expect(productSchema.parse({ ...base, vat_kind: "exempt", price_includes_vat: "on" }).price_includes_vat).toBe(false);
  });

  it("refuses an unknown kind, a bad duration or a missing name", () => {
    expect(productSchema.safeParse({ ...base, kind: "car" }).success).toBe(false);
    expect(productSchema.safeParse({ ...base, duration_minutes: "0" }).success).toBe(false);
    expect(productSchema.safeParse({ ...base, duration_minutes: "1441" }).success).toBe(false);
    expect(productSchema.safeParse({ ...base, name: "  " }).success).toBe(false);
  });

  it("offers only active products that are not archived", () => {
    expect(isOfferable({ isActive: true, archivedAt: null })).toBe(true);
    expect(isOfferable({ isActive: false, archivedAt: null })).toBe(false);
    expect(isOfferable({ isActive: true, archivedAt: "2026-10-13T10:00:00Z" })).toBe(false);
  });

  it("names a copy and keeps it within the limit", () => {
    expect(copyName("שולחן")).toBe("עותק של שולחן");
    expect(copyName("x".repeat(200)).length).toBe(200);
  });
});
