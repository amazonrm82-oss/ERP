import { describe, expect, it } from "vitest";

import { isFutureVatDay, parseVatPercent, vatPercentInput, withVatRateStatus } from "@/features/platform/vat-rates";

// ADM-01: the platform screen's VAT rate helpers
describe("platform VAT rates", () => {
  const rates = [
    { id: "a", effectiveFrom: "2015-10-01", rateBp: 1700, note: null },
    { id: "c", effectiveFrom: "2027-01-01", rateBp: 1900, note: null },
    { id: "b", effectiveFrom: "2025-01-01", rateBp: 1800, note: null },
  ];

  it("marks the rate of today in force, later ones future, older ones replaced; newest first", () => {
    expect(withVatRateStatus(rates, "2026-10-15").map((r) => [r.id, r.status])).toEqual([
      ["c", "future"],
      ["b", "in_force"],
      ["a", "past"],
    ]);
    // the first day of a rate is already in force (locked)
    expect(withVatRateStatus(rates, "2027-01-01").map((r) => r.status)).toEqual(["in_force", "past", "past"]);
    // before every rate: all future
    expect(withVatRateStatus(rates, "2015-09-30").every((r) => r.status === "future")).toBe(true);
  });

  it("reads a percent into basis points, within 0..100 and two decimals", () => {
    expect(parseVatPercent("18")).toBe(1800);
    expect(parseVatPercent(" 17.5% ")).toBe(1750);
    expect(parseVatPercent("17,25")).toBe(1725);
    expect(parseVatPercent("0")).toBe(0);
    expect(parseVatPercent("100")).toBe(10000);
    for (const bad of ["", "-1", "100.01", "101", "17.555", "abc", "1e2", "18%%"]) expect(parseVatPercent(bad), bad).toBeNull();
    expect(vatPercentInput(1750)).toBe("17.5");
    expect(parseVatPercent(vatPercentInput(1725))).toBe(1725);
  });

  it("only a calendar day after today", () => {
    expect(isFutureVatDay("2026-10-16", "2026-10-15")).toBe(true);
    expect(isFutureVatDay("2026-10-15", "2026-10-15")).toBe(false);
    expect(isFutureVatDay("2026-02-30", "2026-01-01")).toBe(false);
  });
});
