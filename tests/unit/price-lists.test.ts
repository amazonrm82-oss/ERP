import { describe, expect, it } from "vitest";

import { priceListSchema } from "@/features/price-lists/schema";
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
