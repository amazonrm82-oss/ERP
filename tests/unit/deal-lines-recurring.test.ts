import { describe, expect, it } from "vitest";

import { lineBillingText, linesBillingNotice } from "@/features/deal-lines/recurring";
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

describe("linesBillingNotice", () => {
  it("says nothing when every product line fits the deal's kind", () => {
    expect(linesBillingNotice("monthly", ["monthly", "monthly", null])).toBeNull();
    expect(linesBillingNotice("yearly", ["yearly"])).toBeNull();
    expect(linesBillingNotice(null, ["one_time", null])).toBeNull();
    expect(linesBillingNotice("monthly", [])).toBeNull();
    expect(linesBillingNotice("monthly", [null, undefined])).toBeNull();
  });

  it("warns that a recurring deal counts every line per period", () => {
    const one = linesBillingNotice("monthly", ["monthly", "one_time"]) ?? "";
    expect(one).toContain("בעסקה חודשית");
    expect(one).toContain("לחודש");
    expect(one).toContain("חד-פעמי");
    expect(one).toContain("שורה אחת");
    const many = linesBillingNotice("yearly", ["quarterly", "monthly", "monthly"]) ?? "";
    expect(many).toContain("בעסקה שנתית");
    expect(many).toContain("3 שורות");
    expect(many).toContain("רבעוני, חודשי");
  });

  it("warns that a one-time deal counts recurring products once", () => {
    const text = linesBillingNotice(null, ["monthly", "one_time"]) ?? "";
    expect(text).toContain("חד-פעמית");
    expect(text).toContain("חודשי");
    expect(text).toContain("שורה אחת");
    expect(linesBillingNotice("one_time", ["yearly"])).not.toBeNull();
  });

  it("ignores values that are not a billing", () => {
    expect(linesBillingNotice("monthly", ["weekly" as never])).toBeNull();
  });
});
