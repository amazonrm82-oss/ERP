import { describe, expect, it } from "vitest";

import { discountedPrice, tierFor, unitPriceFor, type PriceListForPricing, type PriceListLineRule } from "@/features/price-lists/price";
import { productPriceFor } from "@/features/products/price";

// PL-01, PL-02: the unit price of a product from a price list, for a quantity and a day.
describe("unit price from a price list (PL-02)", () => {
  const widget = { id: "p1", priceAgorot: 10000, priceIncludesVat: false, vatKind: "taxable" as const };
  const gross = { id: "p2", priceAgorot: 11800, priceIncludesVat: true, vatKind: "taxable" as const };
  const exempt = { id: "p3", priceAgorot: 5000, priceIncludesVat: false, vatKind: "exempt" as const };
  const line = (values: Partial<PriceListLineRule> & { id: string; productId: string }): PriceListLineRule => ({
    minQuantity: 0,
    priceAgorot: null,
    discountBp: null,
    priceIncludesVat: false,
    ...values,
  });
  const list: PriceListForPricing = {
    isActive: true,
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
    lines: [
      line({ id: "a", productId: "p1", priceAgorot: 9000 }),
      line({ id: "b", productId: "p1", minQuantity: 10, priceAgorot: 8000 }),
      line({ id: "c", productId: "p1", minQuantity: 100, discountBp: 3000 }),
      line({ id: "d", productId: "p2", discountBp: 1000 }),
      line({ id: "e", productId: "p3", priceAgorot: 4000, priceIncludesVat: true }),
    ],
  };
  const day = "2026-06-01";

  it("without a list, the product's own price (the default price list)", () => {
    expect(unitPriceFor(widget, null, 1, day)).toEqual({ priceAgorot: 10000, priceIncludesVat: false, source: "product", lineId: null });
  });

  it("quantity tiers: the largest minimum not above the quantity wins", () => {
    expect(unitPriceFor(widget, list, 1, day)).toMatchObject({ priceAgorot: 9000, source: "list_price", lineId: "a" });
    expect(unitPriceFor(widget, list, 9.999, day)).toMatchObject({ priceAgorot: 9000, lineId: "a" });
    expect(unitPriceFor(widget, list, 10, day)).toMatchObject({ priceAgorot: 8000, lineId: "b" });
    expect(unitPriceFor(widget, list, 99, day)).toMatchObject({ priceAgorot: 8000, lineId: "b" });
    // 30% off the product's own price, not off the tier below
    expect(unitPriceFor(widget, list, 100, day)).toMatchObject({ priceAgorot: 7000, source: "list_discount", lineId: "c" });
  });

  it("below the smallest tier, the product's own price", () => {
    const onlyBulk: PriceListForPricing = { ...list, lines: [line({ id: "b", productId: "p1", minQuantity: 10, priceAgorot: 8000 })] };
    expect(unitPriceFor(widget, onlyBulk, 3, day)).toMatchObject({ priceAgorot: 10000, source: "product", lineId: null });
    expect(unitPriceFor(widget, onlyBulk, 10, day)).toMatchObject({ priceAgorot: 8000, source: "list_price" });
  });

  it("a product the list does not mention keeps its own price", () => {
    expect(unitPriceFor({ ...widget, id: "other" }, list, 50, day)).toMatchObject({ priceAgorot: 10000, source: "product" });
  });

  it("outside the list's dates, or when it is inactive, the product's own price", () => {
    expect(unitPriceFor(widget, list, 10, "2025-12-31").source).toBe("product");
    expect(unitPriceFor(widget, list, 10, "2026-01-01").source).toBe("list_price");
    expect(unitPriceFor(widget, list, 10, "2026-12-31").source).toBe("list_price");
    expect(unitPriceFor(widget, list, 10, "2027-01-01").source).toBe("product");
    expect(unitPriceFor(widget, { ...list, isActive: false }, 10, day).source).toBe("product");
  });

  it("a discount keeps the product's mode; a fixed price keeps its own", () => {
    // 10% off 118.00 including VAT = 106.20 including VAT
    expect(unitPriceFor(gross, list, 1, day)).toEqual({ priceAgorot: 10620, priceIncludesVat: true, source: "list_discount", lineId: "d" });
    // a fixed price typed "including VAT" on a product with no VAT is its net price
    expect(unitPriceFor(exempt, list, 1, day)).toEqual({ priceAgorot: 4000, priceIncludesVat: false, source: "list_price", lineId: "e" });
  });

  it("the answer goes into a document's mode like a product's price", () => {
    const price = unitPriceFor(gross, list, 1, day);
    // 106.20 including 18% VAT = 90.00 before VAT
    expect(productPriceFor({ ...price, vatKind: gross.vatKind }, false, 1800)).toBe(9000);
  });

  // Owner, 13 October 2026: one VAT setting per list; the database copies it onto every fixed price
  // (trigger price_list_lines_vat), so a list's lines all carry the list's flag and a discount carries none.
  describe("one VAT mode per list", () => {
    const listOf = (includesVat: boolean): PriceListForPricing => ({
      isActive: true,
      validFrom: null,
      validTo: null,
      lines: [
        line({ id: "w", productId: "p1", priceAgorot: 11800, priceIncludesVat: includesVat }),
        line({ id: "g", productId: "p2", priceAgorot: 10000, priceIncludesVat: includesVat }),
        line({ id: "x", productId: "p3", priceAgorot: 4000, priceIncludesVat: includesVat }),
        line({ id: "d", productId: "p1", minQuantity: 10, discountBp: 1000 }),
      ],
    });

    it("a list including VAT: a fixed price is gross whatever the product's own mode", () => {
      const list = listOf(true);
      expect(unitPriceFor(widget, list, 1, day)).toEqual({ priceAgorot: 11800, priceIncludesVat: true, source: "list_price", lineId: "w" });
      expect(unitPriceFor(gross, list, 1, day)).toEqual({ priceAgorot: 10000, priceIncludesVat: true, source: "list_price", lineId: "g" });
      // a product without VAT: its price is its net, as productPriceFor() reads it
      expect(unitPriceFor(exempt, list, 1, day)).toEqual({ priceAgorot: 4000, priceIncludesVat: false, source: "list_price", lineId: "x" });
    });

    it("a list before VAT: a fixed price is net whatever the product's own mode", () => {
      const list = listOf(false);
      expect(unitPriceFor(widget, list, 1, day)).toEqual({ priceAgorot: 11800, priceIncludesVat: false, source: "list_price", lineId: "w" });
      expect(unitPriceFor(gross, list, 1, day)).toEqual({ priceAgorot: 10000, priceIncludesVat: false, source: "list_price", lineId: "g" });
    });

    it("a discount keeps the product's own mode in either list", () => {
      for (const includesVat of [true, false]) {
        expect(unitPriceFor(widget, listOf(includesVat), 10, day)).toEqual({ priceAgorot: 9000, priceIncludesVat: false, source: "list_discount", lineId: "d" });
      }
    });

    it("into a document's mode exactly like a product's price typed in the same mode", () => {
      for (const includesVat of [true, false]) {
        const price = unitPriceFor(widget, listOf(includesVat), 1, day);
        const asProduct = { priceAgorot: 11800, priceIncludesVat: includesVat, vatKind: "taxable" as const };
        for (const documentIncludesVat of [true, false]) {
          expect(productPriceFor({ ...price, vatKind: widget.vatKind }, documentIncludesVat, 1800)).toBe(productPriceFor(asProduct, documentIncludesVat, 1800));
        }
      }
      // 118.00 including 18% VAT = 100.00 before VAT; 118.00 before VAT = 139.24 including
      expect(productPriceFor({ ...unitPriceFor(widget, listOf(true), 1, day), vatKind: "taxable" }, false, 1800)).toBe(10000);
      expect(productPriceFor({ ...unitPriceFor(widget, listOf(false), 1, day), vatKind: "taxable" }, true, 1800)).toBe(13924);
    });
  });

  it("rounds a discount half up to the agora, exactly", () => {
    expect(discountedPrice(999, 5000)).toBe(500); // 499.5 -> 500
    expect(discountedPrice(1001, 5000)).toBe(501); // 500.5 -> 501
    expect(discountedPrice(333, 3333)).toBe(222); // 221.9889 -> 222
    expect(discountedPrice(100, 10000)).toBe(0);
    expect(discountedPrice(1_000_000_000_000, 1)).toBe(999_900_000_000);
    expect(() => discountedPrice(-1, 10)).toThrow(RangeError);
    expect(() => discountedPrice(100, 10001)).toThrow(RangeError);
  });

  it("compares quantities in thousandths, as the database stores them", () => {
    const lines = [line({ id: "x", productId: "p1", minQuantity: 0.1, priceAgorot: 1 }), line({ id: "y", productId: "p1", minQuantity: 0.3, priceAgorot: 2 })];
    // 0.1 + 0.2 is 0.30000000000000004 in floating point
    expect(tierFor(lines, "p1", 0.1 + 0.2)?.id).toBe("y");
    expect(tierFor(lines, "p1", 0.05)).toBeNull();
  });

  it("refuses a negative or non-finite quantity", () => {
    expect(() => unitPriceFor(widget, list, -1, day)).toThrow(RangeError);
    expect(() => unitPriceFor(widget, list, Number.NaN, day)).toThrow(RangeError);
  });
});
