import { z } from "zod";

import { isCalendarDate } from "@/lib/calendar-date";
import { formatMoney, parseMoneyToAgorot } from "@/lib/format";

// Recurring revenue on a deal (DEAL-07, migration deal_recurring).
// deals.billing_kind is null for a one-time deal (the default) or 'monthly' / 'yearly';
// a recurring deal needs an amount (agorot, the deal's currency) and a start date, and may
// have a renewal date on or after the start (constraint deals_recurring_shape).
//
// The deal's value and the first-year rule (owner, 14 October 2026) live in the database:
// trigger deals_amount_auto applies app.deal_value() to every writer and derives
// deals.amount_auto (true = the value is computed, 12 x monthly or the yearly amount).
// dealValueRule() below mirrors app.deal_value(); tests/unit/fixtures/deal-value.json is
// checked against both. The app sends amount_agorot = null for an empty value field.

export const BILLING_KINDS = ["one_time", "monthly", "yearly"] as const;
export type BillingKind = (typeof BILLING_KINDS)[number];
export type RecurringKind = Exclude<BillingKind, "one_time">;

export const BILLING_KIND_LABELS: Record<BillingKind, string> = {
  one_time: "חד-פעמית",
  monthly: "חודשית",
  yearly: "שנתית",
};

// "₪500 לחודש"
const PER: Record<RecurringKind, string> = { monthly: "לחודש", yearly: "לשנה" };

/** The kind stored in the database (null = one-time) as the form's value. */
export function billingKindOf(stored: string | null | undefined): BillingKind {
  return stored === "monthly" || stored === "yearly" ? stored : "one_time";
}

/** The form's value as stored in the database. */
export function storedBillingKind(kind: BillingKind): RecurringKind | null {
  return kind === "one_time" ? null : kind;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function daysInMonth(year: number, month: number): number {
  // month 1..12; day 0 of the next month is the last day of this one (UTC, no zone).
  // setUTCFullYear, not Date.UTC: Date.UTC reads years 0..99 as 1900..1999.
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

/**
 * The suggested renewal date: one month or one year after the start, kept on the
 * same day of the month, or the month's last day when it is shorter (31 January →
 * 28/29 February; 29 February → 28 February the next year). null for one-time or
 * an invalid start.
 */
export function suggestRenewalDate(start: string, kind: BillingKind): string | null {
  if (kind === "one_time" || !isCalendarDate(start)) return null;
  const [y, m, d] = start.split("-").map(Number);
  let year = y;
  let month = m;
  if (kind === "monthly") {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  } else {
    year += 1;
  }
  if (year > 9999) return null;
  const day = Math.min(d, daysInMonth(year, month));
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** The first-year value of a recurring deal in agorot (12 x monthly, the yearly amount); null for one-time. */
export function firstYearValue(kind: string | null, recurringAgorot: number | null): number | null {
  if (recurringAgorot === null) return null;
  if (kind === "monthly") return recurringAgorot * 12;
  if (kind === "yearly") return recurringAgorot;
  return null;
}

export type DealValueInput = {
  kind: string | null;
  recurring: number | null;
  // null = the value field was left empty
  amount: number | null;
  oldAmount: number | null;
  oldAuto: boolean | null;
  insert: boolean;
};
export type DealValueResult = { amount: number; auto: true | null } | { error: "deal:amount_too_big" };

/**
 * Mirror of app.deal_value() (migration deal_recurring): the stored value and flag.
 * Empty, or unchanged while computed: follows the recurring terms (0 and no flag on a
 * one-time deal). Anything else (typed, given on insert, or unchanged and not computed):
 * kept, flag off; a typed value turns the flag off even when it equals the first-year value.
 */
export function dealValueRule(input: DealValueInput): DealValueResult {
  const computed = firstYearValue(input.kind, input.recurring);
  const follows =
    input.amount === null || (!input.insert && input.amount === input.oldAmount && input.oldAuto === true && computed !== null);
  if (follows) {
    if (computed === null) return { amount: 0, auto: null };
    if (!Number.isSafeInteger(computed)) return { error: "deal:amount_too_big" };
    return { amount: computed, auto: true };
  }
  return { amount: input.amount as number, auto: null };
}

/** Agorot as a shekel input value ("1200", "1200.50"); "" for none. */
export function agorotInput(agorot: number | null | undefined): string {
  if (agorot === null || agorot === undefined) return "";
  return agorot % 100 === 0 ? String(agorot / 100) : (agorot / 100).toFixed(2);
}

// shown next to a value the system computed (deals.amount_auto)
export const FIRST_YEAR_NOTE = "(לפי שנה ראשונה)";

/** "₪500 לחודש" / "₪6,000 לשנה"; null for a one-time deal. */
export function recurringText(stored: string | null | undefined, amountAgorot: number | null | undefined): string | null {
  const kind = billingKindOf(stored);
  if (kind === "one_time" || amountAgorot === null || amountAgorot === undefined) return null;
  return `${formatMoney(amountAgorot)} ${PER[kind]}`;
}

export const RECURRING_FIELD_NAMES = ["billing_kind", "recurring_amount", "recurring_start_date", "renewal_date"] as const;

export type RecurringPatch = {
  billing_kind: RecurringKind | null;
  recurring_amount_agorot: number | null;
  recurring_start_date: string | null;
  renewal_date: string | null;
};

const text = z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string());

/**
 * The recurring fields of a deal form. A one-time deal clears every recurring field
 * (whatever the hidden inputs held); a recurring one needs an amount and a start date,
 * and a renewal date, when given, on or after the start.
 */
export const recurringSchema = z
  .object({
    billing_kind: text,
    recurring_amount: text,
    recurring_start_date: text,
    renewal_date: text,
  })
  .transform((input, ctx): RecurringPatch => {
    const kind = (BILLING_KINDS as readonly string[]).includes(input.billing_kind) ? (input.billing_kind as BillingKind) : null;
    if (kind === null) {
      ctx.addIssue({ code: "custom", path: ["billing_kind"], message: "יש לבחור סוג עסקה." });
      return z.NEVER;
    }
    if (kind === "one_time") {
      return { billing_kind: null, recurring_amount_agorot: null, recurring_start_date: null, renewal_date: null };
    }
    let ok = true;
    const amount = input.recurring_amount === "" ? null : parseMoneyToAgorot(input.recurring_amount);
    if (input.recurring_amount === "") {
      ctx.addIssue({ code: "custom", path: ["recurring_amount"], message: kind === "monthly" ? "יש להזין סכום חודשי." : "יש להזין סכום שנתי." });
      ok = false;
    } else if (amount === null) {
      ctx.addIssue({ code: "custom", path: ["recurring_amount"], message: "יש להזין סכום בשקלים, למשל 1,200." });
      ok = false;
    }
    if (!isCalendarDate(input.recurring_start_date)) {
      ctx.addIssue({
        code: "custom",
        path: ["recurring_start_date"],
        message: input.recurring_start_date === "" ? "יש לבחור תאריך התחלה." : "התאריך אינו תקין.",
      });
      ok = false;
    }
    if (input.renewal_date !== "" && !isCalendarDate(input.renewal_date)) {
      ctx.addIssue({ code: "custom", path: ["renewal_date"], message: "התאריך אינו תקין." });
      ok = false;
    } else if (input.renewal_date !== "" && isCalendarDate(input.recurring_start_date) && input.renewal_date < input.recurring_start_date) {
      ctx.addIssue({ code: "custom", path: ["renewal_date"], message: "תאריך החידוש לא יכול להיות לפני תאריך ההתחלה." });
      ok = false;
    }
    if (!ok || amount === null) return z.NEVER;
    return {
      billing_kind: kind,
      recurring_amount_agorot: amount,
      recurring_start_date: input.recurring_start_date,
      renewal_date: input.renewal_date === "" ? null : input.renewal_date,
    };
  });

/** The value field as sent: null when it was left empty (the database then decides). */
export function typedDealValue(amountRaw: unknown, typedAgorot: number): number | null {
  return typeof amountRaw !== "string" || amountRaw.trim() === "" ? null : typedAgorot;
}
