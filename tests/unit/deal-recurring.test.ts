import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  agorotInput,
  billingKindOf,
  dealValueHint,
  dealValueNote,
  dealValueRule,
  FIRST_YEAR_NOTE,
  firstYearValue,
  LINES_NOTE,
  linesValueNote,
  recurringFormSchema,
  recurringSchema,
  recurringText,
  shownRecurringAmount,
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
  // DLI-03 cases also carry the lines' sum and the old recurring state, and expect the source and the recurring amount
  lines?: number | null;
  old_recurring?: number | null;
  old_recurring_auto?: boolean | null;
  old_source?: string | null;
  expect:
    | { amount: number; auto: true | null; source?: string | null; recurring?: number | null; recurring_auto?: true | null }
    | { error: "deal:amount_too_big" };
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
    const result = dealValueRule({
      kind: f.kind,
      recurring: f.recurring,
      amount: f.amount,
      oldAmount: f.old_amount,
      oldAuto: f.old_auto,
      insert: f.insert,
      lines: f.lines ?? null,
      oldRecurring: f.old_recurring ?? null,
      oldRecurringAuto: f.old_recurring_auto ?? null,
      oldSource: f.old_source ?? null,
    });
    if ("error" in result || "error" in f.expect) {
      expect(result).toEqual(f.expect);
      return;
    }
    // the DEAL-07 cases expect the value and the flag; the DLI-03 cases also the source and the recurring amount
    const shaped: Record<string, unknown> = { amount: result.amount, auto: result.auto };
    if ("source" in f.expect) shaped.source = result.source;
    if ("recurring" in f.expect) shaped.recurring = result.recurring;
    if ("recurring_auto" in f.expect) shaped.recurring_auto = result.recurringAuto;
    expect(shaped).toEqual(f.expect);
  });

  it("the fixtures cover every DLI-03 case the owner named", () => {
    const names = FIXTURES.map((f) => f.name).join("\n");
    for (const part of [
      "no lines",
      "lines added",
      "monthly, recurring following",
      "yearly, recurring following",
      "typed recurring amount plus lines",
      "a typed value survives",
      "value cleared",
      "all lines removed: empty",
      "all lines removed: the first year",
    ]) {
      expect(names, part).toContain(part);
    }
  });

  it("an empty value field is sent as null; a typed one as typed", () => {
    expect(typedDealValue("", 0)).toBeNull();
    expect(typedDealValue("  ", 0)).toBeNull();
    expect(typedDealValue(null, 0)).toBeNull();
    expect(typedDealValue("0", 0)).toBe(0);
    expect(typedDealValue("2,000", 200000)).toBe(200000);
  });
});

// DLI-03: the deal value from the product lines (owner, 14 October 2026)
describe("deal value from product lines (DLI-03)", () => {
  it("the mark says which source a computed value follows; a value computed before DLI-03 was a first year", () => {
    expect(LINES_NOTE).toBe("(לפי שורות המוצר)");
    expect(FIRST_YEAR_NOTE).toBe("(לפי שנה ראשונה)");
    expect(dealValueNote(true, "lines")).toBe(LINES_NOTE);
    expect(dealValueNote(true, "first_year")).toBe(FIRST_YEAR_NOTE);
    expect(dealValueNote(true, null)).toBe(FIRST_YEAR_NOTE);
    expect(dealValueNote(false, null)).toBeNull();
    expect(dealValueNote(null, "lines")).toBeNull();
  });

  it("the form's hint follows the source", () => {
    expect(dealValueHint(true, "lines")).toContain("שורות המוצר");
    expect(dealValueHint(true, null)).toContain("שנה ראשונה");
    expect(dealValueHint(false, null)).toContain("שדה ריק");
  });

  it("the lines card says what the value does with the lines", () => {
    expect(linesValueNote({ kind: null, auto: true, source: "lines", recurringAuto: false })).toBe('שווי העסקה מחושב מסכום השורות לפני מע"מ.');
    expect(linesValueNote({ kind: null, auto: false, source: null, recurringAuto: false })).toContain("הוקלד ביד");
    expect(linesValueNote({ kind: "monthly", auto: true, source: "lines", recurringAuto: true })).toBe(
      'הסכום החודשי מחושב מסכום השורות לפני מע"מ. שווי העסקה לפי שנה ראשונה.',
    );
    expect(linesValueNote({ kind: "yearly", auto: true, source: "first_year", recurringAuto: false })).toContain("הסכום השנתי הוקלד ביד");
    expect(linesValueNote({ kind: "monthly", auto: false, source: null, recurringAuto: true })).toContain("שווי העסקה הוקלד ביד");
  });

  it("the deal form may leave a recurring amount empty (it follows the lines); an import may not", () => {
    const input = form({ billing_kind: "monthly", recurring_amount: "", recurring_start_date: "2026-01-01" });
    expect(recurringFormSchema.parse(input)).toEqual({
      billing_kind: "monthly",
      recurring_amount_agorot: null,
      recurring_start_date: "2026-01-01",
      renewal_date: null,
    });
    expect(errorsOf(input).recurring_amount).toBe("יש להזין סכום חודשי.");
    // a bad amount is still refused by both
    const bad = form({ billing_kind: "monthly", recurring_amount: "abc", recurring_start_date: "2026-01-01" });
    expect(recurringFormSchema.safeParse(bad).success).toBe(false);
    // and the start date is still needed
    expect(recurringFormSchema.safeParse(form({ billing_kind: "yearly" })).success).toBe(false);
  });

  it("an amount still waiting for lines shows as empty, never as ₪0 לחודש", () => {
    expect(shownRecurringAmount(0, true)).toBeNull();
    expect(recurringText("monthly", shownRecurringAmount(0, true))).toBeNull();
    expect(shownRecurringAmount(0, null)).toBe(0);
    expect(shownRecurringAmount(30000, true)).toBe(30000);
    expect(shownRecurringAmount(null, true)).toBeNull();
  });
});
