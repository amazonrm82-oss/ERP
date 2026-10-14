import { describe, expect, it } from "vitest";

import { dealLinesSums } from "@/features/deal-lines/pricing";
import { lineBillingText, MAKE_RECURRING_LABEL, makeRecurringOffer, ownBilling } from "@/features/deal-lines/recurring";
import { monthlyRecurringAgorot, recurringText } from "@/features/deals/recurring";

// DLI-04: monthly recurring revenue of a deal and how product lines bill.

describe("monthlyRecurringAgorot", () => {
  it("is the monthly amount, or a yearly amount over 12 half up", () => {
    expect(monthlyRecurringAgorot("monthly", 50000)).toBe(50000);
    expect(monthlyRecurringAgorot("yearly", 600000)).toBe(50000);
    expect(monthlyRecurringAgorot("yearly", 100)).toBe(8); // 8.33
    expect(monthlyRecurringAgorot("yearly", 102)).toBe(9); // 8.5 -> 9
    expect(monthlyRecurringAgorot("yearly", 101)).toBe(8); // 8.42
    expect(monthlyRecurringAgorot("yearly", 0)).toBe(0);
    expect(monthlyRecurringAgorot("yearly", 9007199254740991)).toBe(750599937895083);
  });

  it("is null for a one-time deal or no amount", () => {
    expect(monthlyRecurringAgorot(null, 50000)).toBeNull();
    expect(monthlyRecurringAgorot("one_time", 50000)).toBeNull();
    expect(monthlyRecurringAgorot("monthly", null)).toBeNull();
    expect(monthlyRecurringAgorot("yearly", undefined)).toBeNull();
  });
});

describe("recurringText with the monthly share", () => {
  it("adds the monthly share to a yearly amount only", () => {
    const yearly = recurringText("yearly", 600000) ?? "";
    expect(yearly).toContain("לשנה");
    expect(yearly).toContain("לחודש");
    expect(yearly).toContain("500");
    expect(recurringText("monthly", 50000)).not.toContain("(");
    expect(recurringText("yearly", 0)).not.toContain("(");
  });
});

describe("lineBillingText", () => {
  it("names a cyclic billing and nothing else", () => {
    expect(lineBillingText("monthly")).toBe(", חיוב חודשי");
    expect(lineBillingText("quarterly")).toBe(", חיוב רבעוני");
    expect(lineBillingText("yearly")).toBe(", חיוב שנתי");
    expect(lineBillingText("one_time")).toBe("");
    expect(lineBillingText(null)).toBe("");
    expect(lineBillingText(undefined)).toBe("");
  });
});

describe("makeRecurringOffer (DLI-04)", () => {
  it("a recurring deal never warns: each line counts by its own mode", () => {
    expect(makeRecurringOffer("monthly", ["monthly", "one_time", "yearly", null])).toBeNull();
    expect(makeRecurringOffer("yearly", ["quarterly", "monthly"])).toBeNull();
  });

  it("a one-time deal with only one-time lines (or lines saved before DLI-04) has nothing to offer", () => {
    expect(makeRecurringOffer(null, ["one_time", null])).toBeNull();
    expect(makeRecurringOffer(null, [])).toBeNull();
    expect(makeRecurringOffer(null, [undefined])).toBeNull();
  });

  it("a one-time deal with a recurring line offers to make it recurring and says how the line counts now", () => {
    const one = makeRecurringOffer(null, ["monthly", "one_time"]) ?? "";
    expect(one).toContain("חודשי");
    expect(one).toContain("שורה אחת");
    expect(one).toContain("שנה ראשונה");
    expect(one).toContain("חוזרת");
    const many = makeRecurringOffer("one_time", ["quarterly", "monthly", "monthly"]) ?? "";
    expect(many).toContain("3 שורות");
    expect(many).toContain("רבעוני, חודשי");
    expect(MAKE_RECURRING_LABEL).toBe("להפוך לעסקה חוזרת");
  });

  it("ignores values that are not a billing", () => {
    expect(makeRecurringOffer(null, ["weekly" as never])).toBeNull();
  });
});

describe("ownBilling", () => {
  it("a line saved before DLI-04 counts in the deal's own period", () => {
    expect(ownBilling("monthly")).toBe("monthly");
    expect(ownBilling("yearly")).toBe("yearly");
    expect(ownBilling(null)).toBe("one_time");
  });
});

describe("dealLinesSums (mirror of app.deal_lines_sums)", () => {
  const line = (unit: number, billing: "one_time" | "monthly" | "quarterly" | "yearly" | null) => ({
    quantity: 1,
    unitPriceAgorot: unit,
    discountBp: null,
    discountAgorot: null,
    vatExempt: false,
    billing,
  });
  it("sums per mode; a mode without lines is null", () => {
    expect(dealLinesSums([line(100, "monthly"), line(200, "monthly"), line(50, "one_time")], null, 0, false)).toEqual({
      once: 50,
      monthly: 300,
      quarterly: null,
      yearly: null,
    });
    expect(dealLinesSums([], "monthly", 0, false)).toEqual({ once: null, monthly: null, quarterly: null, yearly: null });
  });
  it("a line saved before DLI-04 counts in the deal's own period", () => {
    expect(dealLinesSums([line(100, null)], "yearly", 0, false).yearly).toBe(100);
    expect(dealLinesSums([line(100, null)], null, 0, false).once).toBe(100);
  });
  it("prices including VAT are carried back per mode group", () => {
    // 11800 including 18% = 10000 before VAT
    expect(dealLinesSums([line(11800, "quarterly")], null, 1800, true).quarterly).toBe(10000);
  });
});
