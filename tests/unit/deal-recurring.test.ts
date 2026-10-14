import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  agorotInput,
  billingKindOf,
  dealValueRule,
  firstYearValue,
  recurringSchema,
  recurringText,
  storedBillingKind,
  suggestRenewalDate,
  typedDealValue,
} from "@/features/deals/recurring";

const form = (values: Partial<Record<string, string>>) => ({
  billing_kind: "one_time",
  recurring_amount: "",
  recurring_start_date: "",
  renewal_date: "",
  ...values,
});

const errorsOf = (input: unknown) => {
  const r = recurringSchema.safeParse(input);
  if (r.success) return {};
  return Object.fromEntries(r.error.issues.map((issue) => [String(issue.path[0]), issue.message]));
};

describe("suggested renewal date (DEAL-07)", () => {
  it("is one month or one year after the start", () => {
    expect(suggestRenewalDate("2026-03-15", "monthly")).toBe("2026-04-15");
    expect(suggestRenewalDate("2026-03-15", "yearly")).toBe("2027-03-15");
  });

  it("crosses the year end", () => {
    expect(suggestRenewalDate("2026-12-10", "monthly")).toBe("2027-01-10");
  });

  it("keeps to the month's last day when the next month is shorter", () => {
    expect(suggestRenewalDate("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(suggestRenewalDate("2028-01-31", "monthly")).toBe("2028-02-29");
    expect(suggestRenewalDate("2026-03-31", "monthly")).toBe("2026-04-30");
    expect(suggestRenewalDate("2028-02-29", "yearly")).toBe("2029-02-28");
    // years 0..99 are not read as 1900..1999
    expect(suggestRenewalDate("0004-01-31", "monthly")).toBe("0004-02-29");
    expect(suggestRenewalDate("0099-01-31", "monthly")).toBe("0099-02-28");
    expect(suggestRenewalDate("0003-02-28", "yearly")).toBe("0004-02-28");
    // year 0 is a leap year (1900 is not)
    expect(suggestRenewalDate("0000-01-31", "monthly")).toBe("0000-02-29");
  });

  it("has no suggestion for a one-time deal or a bad start", () => {
    expect(suggestRenewalDate("2026-03-15", "one_time")).toBeNull();
    expect(suggestRenewalDate("", "monthly")).toBeNull();
    expect(suggestRenewalDate("2026-02-30", "monthly")).toBeNull();
    expect(suggestRenewalDate("9999-12-15", "monthly")).toBeNull();
  });
});

describe("billing kind mapping", () => {
  it("null and unknown values are one-time; one-time is stored as null", () => {
    expect(billingKindOf(null)).toBe("one_time");
    expect(billingKindOf("weekly")).toBe("one_time");
    expect(billingKindOf("monthly")).toBe("monthly");
    expect(storedBillingKind("one_time")).toBeNull();
    expect(storedBillingKind("yearly")).toBe("yearly");
  });

  it("formats the recurring amount per period", () => {
    expect(recurringText("monthly", 50000)).toContain("לחודש");
    expect(recurringText("yearly", 50000)).toContain("לשנה");
    expect(recurringText(null, 50000)).toBeNull();
    expect(recurringText("monthly", null)).toBeNull();
    expect(agorotInput(120000)).toBe("1200");
    expect(agorotInput(120050)).toBe("1200.50");
    expect(agorotInput(null)).toBe("");
  });
});

describe("recurring form fields", () => {
  it("one-time clears every recurring field, whatever was typed", () => {
    expect(recurringSchema.parse(form({ recurring_amount: "100", recurring_start_date: "2026-01-01", renewal_date: "x" }))).toEqual({
      billing_kind: null,
      recurring_amount_agorot: null,
      recurring_start_date: null,
      renewal_date: null,
    });
  });

  it("a monthly deal is parsed to agorot and dates; an empty renewal is null", () => {
    expect(recurringSchema.parse(form({ billing_kind: "monthly", recurring_amount: "1,200.5", recurring_start_date: "2026-01-31" }))).toEqual({
      billing_kind: "monthly",
      recurring_amount_agorot: 120050,
      recurring_start_date: "2026-01-31",
      renewal_date: null,
    });
    expect(recurringSchema.parse(form({ billing_kind: "yearly", recurring_amount: "0", recurring_start_date: "2026-01-01", renewal_date: "2026-01-01" })).renewal_date).toBe("2026-01-01");
  });

  it("names every missing or wrong field in Hebrew", () => {
    expect(errorsOf(form({ billing_kind: "monthly" }))).toEqual({
      recurring_amount: "יש להזין סכום חודשי.",
      recurring_start_date: "יש לבחור תאריך התחלה.",
    });
    expect(errorsOf(form({ billing_kind: "yearly", recurring_amount: "abc", recurring_start_date: "2026-02-30" }))).toEqual({
      recurring_amount: "יש להזין סכום בשקלים, למשל 1,200.",
      recurring_start_date: "התאריך אינו תקין.",
    });
    expect(errorsOf(form({ billing_kind: "monthly", recurring_amount: "10", recurring_start_date: "2026-05-02", renewal_date: "2026-05-01" }))).toEqual({
      renewal_date: "תאריך החידוש לא יכול להיות לפני תאריך ההתחלה.",
    });
    expect(errorsOf(form({ billing_kind: "weekly" }))).toEqual({ billing_kind: "יש לבחור סוג עסקה." });
    expect(errorsOf({})).toEqual({ billing_kind: "יש לבחור סוג עסקה." });
  });
});

type Fixture = {
  name: string;
  kind: string | null;
  recurring: number | null;
  amount: number | null;
  old_amount: number | null;
  old_auto: boolean | null;
  insert: boolean;
  expect: { amount: number; auto: true | null } | { error: "deal:amount_too_big" };
};

// the same cases run against app.deal_value() in tests/db/106-deal-recurring.test.ts
const FIXTURES = JSON.parse(readFileSync(new URL("./fixtures/deal-value.json", import.meta.url), "utf8")) as Fixture[];

describe("deal value and first-year value (mirror of app.deal_value)", () => {
  it("the first year is 12 months, or one year; none for one-time", () => {
    expect(firstYearValue("monthly", 50000)).toBe(600000);
    expect(firstYearValue("yearly", 50000)).toBe(50000);
    expect(firstYearValue(null, 50000)).toBeNull();
    expect(firstYearValue("monthly", null)).toBeNull();
  });

  it.each(FIXTURES.map((f) => [f.name, f] as const))("%s", (_name, f) => {
    expect(
      dealValueRule({ kind: f.kind, recurring: f.recurring, amount: f.amount, oldAmount: f.old_amount, oldAuto: f.old_auto, insert: f.insert }),
    ).toEqual(f.expect);
  });

  it("an empty value field is sent as null; a typed one as typed", () => {
    expect(typedDealValue("", 0)).toBeNull();
    expect(typedDealValue("  ", 0)).toBeNull();
    expect(typedDealValue(null, 0)).toBeNull();
    expect(typedDealValue("0", 0)).toBe(0);
    expect(typedDealValue("2,000", 200000)).toBe(200000);
  });
});
