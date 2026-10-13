import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LINE_PRICE_MAX_AGOROT, priceListLineSchema, priceListSchema, TIERS_PER_PRODUCT } from "@/features/price-lists/schema";
import { priceListApplies, priceListStatus, validityText } from "@/features/price-lists/status";

// PL-01: a price list applies while it is active and the day is within its dates (both inclusive, both optional).
describe("price list status (PL-01)", () => {
  const list = { isActive: true, validFrom: "2026-01-01", validTo: "2026-03-31" };

  it("applies from the first day to the last day, inclusive", () => {
    expect(priceListStatus(list, "2025-12-31")).toBe("upcoming");
    expect(priceListStatus(list, "2026-01-01")).toBe("in_force");
    expect(priceListStatus(list, "2026-03-31")).toBe("in_force");
    expect(priceListStatus(list, "2026-04-01")).toBe("ended");
  });

  it("an empty date means no limit on that side", () => {
    expect(priceListApplies({ isActive: true, validFrom: null, validTo: null }, "1999-01-01")).toBe(true);
    expect(priceListApplies({ isActive: true, validFrom: null, validTo: "2026-01-01" }, "2026-01-02")).toBe(false);
    expect(priceListApplies({ isActive: true, validFrom: "2026-01-01", validTo: null }, "2099-01-01")).toBe(true);
  });

  it("an inactive list never applies, whatever its dates", () => {
    expect(priceListStatus({ ...list, isActive: false }, "2026-02-01")).toBe("inactive");
    expect(priceListApplies({ ...list, isActive: false }, "2026-02-01")).toBe(false);
  });

  it("describes the dates as Israelis write them", () => {
    expect(validityText(list)).toBe("01.01.2026 עד 31.03.2026");
    expect(validityText({ validFrom: "2026-01-01", validTo: null })).toBe("מ-01.01.2026");
    expect(validityText({ validFrom: null, validTo: "2026-03-31" })).toBe("עד 31.03.2026");
    expect(validityText({ validFrom: null, validTo: null })).toBe("בלי הגבלת זמן");
  });
});

describe("price list form (PL-01)", () => {
  it("accepts a name with empty dates, and trims it", () => {
    const parsed = priceListSchema.safeParse({ name: "  סיטונאים ", valid_from: "", valid_to: "", is_active: "on" });
    expect(parsed.success && parsed.data).toEqual({ name: "סיטונאים", valid_from: null, valid_to: null, is_active: true });
  });

  it("refuses an end before the start, on the end field, but takes a one-day list", () => {
    const bad = priceListSchema.safeParse({ name: "x", valid_from: "2026-05-02", valid_to: "2026-05-01", is_active: null });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0].path).toEqual(["valid_to"]);
    expect(priceListSchema.safeParse({ name: "x", valid_from: "2026-05-01", valid_to: "2026-05-01", is_active: null }).success).toBe(true);
  });

  it("refuses an empty name, a name over 120 characters and a date that is not a day", () => {
    expect(priceListSchema.safeParse({ name: " ", valid_from: "", valid_to: "", is_active: null }).success).toBe(false);
    expect(priceListSchema.safeParse({ name: "א".repeat(121), valid_from: "", valid_to: "", is_active: null }).success).toBe(false);
    expect(priceListSchema.safeParse({ name: "x", valid_from: "2026-02-30", valid_to: "", is_active: null }).success).toBe(false);
  });
});

describe("price list line form (PL-02)", () => {
  const product = "11111111-1111-4111-8111-111111111111";
  const base = { product_id: product, min_quantity: "", rule: "price", price_agorot: "", discount: "", price_includes_vat: null };

  it("a fixed price from any quantity, with its mode", () => {
    const parsed = priceListLineSchema.safeParse({ ...base, price_agorot: "1,250.5", price_includes_vat: "on" });
    expect(parsed.success && parsed.data).toEqual({ product_id: product, min_quantity: 0, price_agorot: 125050, price_includes_vat: true, discount_bp: null });
  });

  it("a discount in percent becomes basis points and never carries a mode", () => {
    const parsed = priceListLineSchema.safeParse({ ...base, rule: "discount", discount: "12.5", min_quantity: "10", price_includes_vat: "on", price_agorot: "999" });
    expect(parsed.success && parsed.data).toEqual({ product_id: product, min_quantity: 10, price_agorot: null, price_includes_vat: false, discount_bp: 1250 });
    expect(priceListLineSchema.safeParse({ ...base, rule: "discount", discount: "100" }).success).toBe(true);
    expect(priceListLineSchema.safeParse({ ...base, rule: "discount", discount: "0.01" }).success).toBe(true);
  });

  it("refuses a missing price or discount, a discount out of range, and a bad quantity, on the right field", () => {
    const field = (values: Record<string, unknown>) => {
      const parsed = priceListLineSchema.safeParse({ ...base, ...values });
      return parsed.success ? null : parsed.error.issues[0].path[0];
    };
    expect(field({})).toBe("price_agorot");
    expect(field({ price_agorot: "abc" })).toBe("price_agorot");
    expect(field({ price_agorot: "10000000001" })).toBe("price_agorot");
    expect(field({ rule: "discount" })).toBe("discount");
    expect(field({ rule: "discount", discount: "0" })).toBe("discount");
    expect(field({ rule: "discount", discount: "100.01" })).toBe("discount");
    expect(field({ rule: "discount", discount: "5.555" })).toBe("discount");
    expect(field({ price_agorot: "1", min_quantity: "-1" })).toBe("min_quantity");
    expect(field({ price_agorot: "1", min_quantity: "1.2345" })).toBe("min_quantity");
    expect(field({ price_agorot: "1", product_id: "" })).toBe("product_id");
    expect(field({ price_agorot: "1", rule: "other" })).toBe("rule");
    // a price of zero and three decimals of quantity are fine
    expect(field({ price_agorot: "0", min_quantity: "2.125" })).toBeNull();
  });

  it("the limits match the migration", () => {
    const sql = readFileSync(path.resolve(__dirname, "../../supabase/migrations/20261006016500_price_list_lines.sql"), "utf8");
    expect(sql).toContain("discount_bp between 1 and 10000");
    expect(sql).toContain("min_quantity       numeric(12, 3)");
    expect(sql).toContain(`price_agorot between 0 and ${LINE_PRICE_MAX_AGOROT}`);
    expect(sql).toContain(`) >= ${TIERS_PER_PRODUCT} then`);
  });
});
