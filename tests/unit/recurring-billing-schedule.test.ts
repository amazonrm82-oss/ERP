import { describe, expect, it } from "vitest";

import { commitmentEnd, monthlyAmount, nextCycleDate } from "@/features/recurring-billing/schedule";
import { billingAmountText, nextCycleText } from "@/features/recurring-billing/texts";

// SUB-01: the schedule of a recurring billing (app.recurring_next_cycle / app.recurring_monthly_amount; test 357 compares).
describe("recurring billing schedule (SUB-01)", () => {
  it("the first billing date on or after a day, never before the start", () => {
    expect(nextCycleDate("2026-01-15", "monthly", 10, "2026-01-01")).toBe("2026-02-10");
    expect(nextCycleDate("2026-01-15", "monthly", 20, "2026-01-01")).toBe("2026-01-20");
    expect(nextCycleDate("2026-01-15", "monthly", 20, "2026-01-21")).toBe("2026-02-20");
    expect(nextCycleDate("2026-01-15", "quarterly", 20, "2026-03-01")).toBe("2026-04-20");
    expect(nextCycleDate("2026-11-30", "yearly", 28, "2027-02-01")).toBe("2027-11-28");
    expect(nextCycleDate("2026-12-05", "monthly", 5, "2026-12-06")).toBe("2027-01-05");
  });

  it("refuses a billing day outside 0..28", () => {
    expect(nextCycleDate("2026-01-15", "monthly", 29, "2026-01-01")).toBeNull();
    expect(nextCycleDate("2026-01-15", "monthly", -1, "2026-01-01")).toBeNull();
  });

  it("owner (354) ב: 0 is the last day of the month, leap years included", () => {
    expect(nextCycleDate("2026-01-15", "monthly", 0, "2026-01-01")).toBe("2026-01-31");
    expect(nextCycleDate("2026-01-31", "monthly", 0, "2026-02-01")).toBe("2026-02-28");
    expect(nextCycleDate("2028-01-15", "monthly", 0, "2028-02-01")).toBe("2028-02-29");
    expect(nextCycleDate("2026-01-01", "monthly", 0, "2026-04-15")).toBe("2026-04-30");
    expect(nextCycleDate("2024-02-29", "yearly", 0, "2025-01-01")).toBe("2025-02-28");
    expect(nextCycleDate("2027-02-01", "yearly", 0, "2027-03-01")).toBe("2028-02-29");
  });

  it("a cycle's amount per month, half up", () => {
    expect(monthlyAmount(1000, "monthly")).toBe(1000);
    expect(monthlyAmount(1000, "quarterly")).toBe(333);
    expect(monthlyAmount(1001, "quarterly")).toBe(334);
    expect(monthlyAmount(1006, "yearly")).toBe(84);
  });

  it("the commitment's last day", () => {
    expect(commitmentEnd("2026-01-15", 0)).toBeNull();
    expect(commitmentEnd("2026-01-15", 12)).toBe("2027-01-14");
    expect(commitmentEnd("2026-01-31", 1)).toBe("2026-02-27");
  });

  it("texts", () => {
    expect(billingAmountText(50000, "monthly")).toContain("חודשי");
    expect(nextCycleText("paused", "2026-12-01", null)).toContain("מושהה");
    expect(nextCycleText("active", null, "2026-12-01")).toContain("הסתיים");
  });
});
