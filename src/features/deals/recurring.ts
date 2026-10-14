import { z } from "zod";

import { isCalendarDate } from "@/lib/calendar-date";
import { formatMoney, parseMoneyToAgorot } from "@/lib/format";

// Recurring revenue on a deal (DEAL-07, migration deal_recurring).
// deals.billing_kind is null for a one-time deal (the default) or 'monthly' / 'yearly';
// a recurring deal needs an amount (agorot, the deal's currency) and a start date, and may
// have a renewal date on or after the start (constraint deals_recurring_shape).
//
// The deal's value and the first-year rule (owner, 14 October 2026) live in the database:
// trigger deals_amount_auto applies app.deal_amount_rule() to every writer and derives
// deals.amount_auto (true = the value is computed) and deals.amount_source (DLI-03: "lines",
// the before-VAT sum of the product lines, or "first_year", 12 x monthly or the yearly amount),
// and fills recurring_amount_agorot from the lines while nobody typed it (recurring_amount_auto).
// DLI-04: every line has a billing mode; the recurring amount comes from the recurring lines only,
// converted to the deal's period, and the value is their first year plus the one-time lines.
// dealValueRule() below mirrors app.deal_value_rule(); tests/unit/fixtures/deal-value.json is
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

export type DealValueSource = "lines" | "first_year";

/** DLI-04: the before-VAT sums of a deal's lines per billing mode; null = no line of that mode. */
export type LineSums = { once: number | null; monthly: number | null; quarterly: number | null; yearly: number | null };

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** DLI-03's single sum as DLI-04 sums: lines billed in the deal's own period (once on a one-time deal). */
export function ownPeriodSums(kind: string | null, lines: number | null): LineSums {
  return {
    once: kind === null ? lines : null,
    monthly: kind === "monthly" ? lines : null,
    quarterly: null,
    yearly: kind === "yearly" ? lines : null,
  };
}

/** Half up division of a non-negative integer (the amounts are never negative). */
function divideHalfUp(value: number, by: number): number {
  const whole = Math.floor(value / by);
  return value - whole * by >= by / 2 ? whole + 1 : whole;
}

export type DealValueInput = {
  kind: string | null;
  recurring: number | null;
  // null = the value field was left empty
  amount: number | null;
  oldAmount: number | null;
  oldAuto: boolean | null;
  insert: boolean;
  // DLI-03: the before-VAT sum of the deal's product lines, all billed in the deal's own period
  // (the meaning of app.deal_amount_rule()); null = no lines. Ignored when lineSums is given.
  lines?: number | null;
  // DLI-04: the before-VAT sums per billing mode (dealLinesSums(), app.deal_lines_sums); null = no such line
  lineSums?: LineSums | null;
  oldRecurring?: number | null;
  oldRecurringAuto?: boolean | null;
  oldSource?: string | null;
};
export type DealValueResult =
  | {
      amount: number;
      auto: true | null;
      source: DealValueSource | null;
      recurring: number | null;
      recurringAuto: true | null;
    }
  | { error: "deal:amount_too_big" };

/**
 * Mirror of app.deal_value_rule() (migrations deal_recurring, deal_value_from_lines, deal_line_billing): the
 * stored value, its flag and source, and the recurring amount. Owner's order (DLI-03): a typed value; the
 * lines (before VAT); a recurring deal's first year; empty (0). DLI-04: with R = the first year of the
 * recurring lines (12 x monthly + 4 x quarterly + yearly):
 * - The recurring amount (recurring deal only) follows the recurring lines when sent empty, or unchanged
 *   while it was following: R / 12 half up on a monthly deal, R on a yearly one; with no recurring lines
 *   it keeps what it had (0 when empty). Else kept as typed.
 * - Computed: a recurring deal, the first year of its recurring amount plus the one-time lines (source
 *   "lines" when a line takes part, else "first_year"); a one-time deal with lines, R plus the one-time lines.
 * - The value follows it when sent empty, or unchanged while computed; an unchanged 0 nobody
 *   computed follows the lines too ("0 is empty"). An unchanged value computed from lines with
 *   nothing left to compute becomes empty. Anything else is kept, flag off; a typed value turns
 *   the flag off even when it equals the computed one.
 */
export function dealValueRule(input: DealValueInput): DealValueResult {
  const sums = input.lineSums ?? ownPeriodSums(input.kind, input.lines ?? null);
  const hasRecurring = sums.monthly !== null || sums.quarterly !== null || sums.yearly !== null;
  const hasLines = hasRecurring || sums.once !== null;
  let year: number | null = null;
  if (hasRecurring) {
    year = 12 * (sums.monthly ?? 0) + 4 * (sums.quarterly ?? 0) + (sums.yearly ?? 0);
    if (!Number.isSafeInteger(year) || year > MAX_SAFE) return { error: "deal:amount_too_big" };
  }

  let recurring = input.recurring;
  let recurringAuto: true | null = null;
  if (
    input.kind !== null &&
    (input.recurring === null || (!input.insert && input.recurring === (input.oldRecurring ?? null) && input.oldRecurringAuto === true))
  ) {
    recurring = year !== null ? (input.kind === "monthly" ? divideHalfUp(year, 12) : year) : (input.recurring ?? 0);
    recurringAuto = true;
  }

  let computed: number | null = null;
  let source: DealValueSource | null = null;
  if (input.kind !== null) {
    // an amount waiting for lines (following, no recurring lines, 0) is nothing to compute from
    const firstYear = recurringAuto === true && !hasRecurring && recurring === 0 ? null : firstYearValue(input.kind, recurring);
    if (firstYear !== null || sums.once !== null) computed = (firstYear ?? 0) + (sums.once ?? 0);
    source = (recurringAuto === true && hasRecurring) || sums.once !== null ? "lines" : "first_year";
  } else if (hasLines) {
    computed = (year ?? 0) + (sums.once ?? 0);
    source = "lines";
  }

  const unchanged = !input.insert && input.amount === input.oldAmount;
  const follows =
    input.amount === null ||
    (unchanged && input.oldAuto === true && computed !== null) ||
    (unchanged && input.amount === 0 && input.oldAuto !== true && hasLines && computed !== null);
  if (follows) {
    if (computed === null) return { amount: 0, auto: null, source: null, recurring, recurringAuto };
    if (!Number.isSafeInteger(computed)) return { error: "deal:amount_too_big" };
    return { amount: computed, auto: true, source, recurring, recurringAuto };
  }
  if (unchanged && input.oldAuto === true && input.oldSource === "lines") {
    return { amount: 0, auto: null, source: null, recurring, recurringAuto };
  }
  return {
    amount: input.amount as number,
    auto: null,
    source: null,
    recurring,
    recurringAuto,
  };
}

/** Agorot as a shekel input value ("1200", "1200.50"); "" for none. */
export function agorotInput(agorot: number | null | undefined): string {
  if (agorot === null || agorot === undefined) return "";
  return agorot % 100 === 0 ? String(agorot / 100) : (agorot / 100).toFixed(2);
}

// shown next to a value the system computed (deals.amount_auto, deals.amount_source)
export const FIRST_YEAR_NOTE = "(לפי שנה ראשונה)";
export const LINES_NOTE = "(לפי שורות המוצר)";

/**
 * The mark next to a computed value; null for a typed or empty one. A value computed before
 * DLI-03 has the flag and no source: it was a first-year value.
 */
export function dealValueNote(auto: boolean | null | undefined, source: string | null | undefined): string | null {
  if (auto !== true) return null;
  return source === "lines" ? LINES_NOTE : FIRST_YEAR_NOTE;
}

/**
 * DLI-03, DLI-04: what the deal value does with the product lines, for the lines card. A recurring deal's
 * recurring amount follows its recurring lines while nobody typed it; the value is the first year of that
 * amount plus the one-time lines (a one-time deal: the first year of its recurring lines plus the rest),
 * while nobody typed it.
 */
export function linesValueNote(deal: { kind: string | null; auto: boolean; source: string | null; recurringAuto: boolean }): string {
  const typed = "שווי העסקה הוקלד ביד ולא משתנה לפי השורות. כדי לחשב אותו מהשורות, מרוקנים את השווי בפרטי העסקה.";
  const value = "שווי העסקה: שנה ראשונה ועוד השורות החד-פעמיות.";
  if (deal.kind === "monthly" || deal.kind === "yearly") {
    const per = deal.kind === "monthly" ? "הסכום החודשי" : "הסכום השנתי";
    if (!deal.recurringAuto) {
      const own = `${per} הוקלד ביד ולא משתנה לפי השורות. כדי לחשב אותו מהשורות, מרוקנים אותו בפרטי העסקה.`;
      return deal.auto ? `${own} ${value}` : own;
    }
    const recurring = `${per} מחושב מהשורות בחיוב חוזר, לפני מע"מ.`;
    return deal.auto ? `${recurring} ${value}` : `${recurring} ${typed}`;
  }
  return deal.auto && deal.source === "lines"
    ? 'שווי העסקה מחושב מסכום השורות לפני מע"מ. שורה בחיוב חוזר נספרת לפי שנה ראשונה.'
    : typed;
}

/** The value field's hint in the deal form, by what the value follows now. */
export function dealValueHint(auto: boolean, source: string | null): string {
  if (auto && source === "lines") return "מחושב לפי שורות המוצר, לפני מע\"מ. ערך שתקלידו יישאר קבוע; שדה ריק יחזיר את החישוב.";
  if (auto) return "מחושב לפי שנה ראשונה. ערך שתקלידו יישאר קבוע; שדה ריק יחזיר את החישוב.";
  return "שדה ריק יחושב לפי שורות המוצר, או בעסקה חוזרת לפי שנה ראשונה.";
}

/**
 * DLI-03: the recurring amount as shown. An amount that follows the product lines while the
 * deal has none holds 0 and means "empty, waiting for lines": shown as no amount.
 */
export function shownRecurringAmount(amountAgorot: number | null, following: boolean | null | undefined): number | null {
  return following === true && amountAgorot === 0 ? null : amountAgorot;
}

/**
 * DLI-04: the deal's monthly recurring revenue in agorot: the monthly amount, or a yearly amount
 * divided by 12, half up (the rounding of app.document_totals). null for a one-time deal or no amount.
 */
export function monthlyRecurringAgorot(stored: string | null | undefined, amountAgorot: number | null | undefined): number | null {
  const kind = billingKindOf(stored);
  if (kind === "one_time" || amountAgorot === null || amountAgorot === undefined) return null;
  if (kind === "monthly") return amountAgorot;
  const whole = Math.floor(amountAgorot / 12);
  return amountAgorot - whole * 12 >= 6 ? whole + 1 : whole;
}

/**
 * "₪500 לחודש" / "₪6,000 לשנה (₪500 לחודש)"; null for a one-time deal. DLI-04: a yearly amount
 * also says its monthly share (monthlyRecurringAgorot()).
 */
export function recurringText(stored: string | null | undefined, amountAgorot: number | null | undefined): string | null {
  const kind = billingKindOf(stored);
  if (kind === "one_time" || amountAgorot === null || amountAgorot === undefined) return null;
  const text = `${formatMoney(amountAgorot)} ${PER[kind]}`;
  if (kind === "yearly" && amountAgorot > 0) return `${text} (${formatMoney(monthlyRecurringAgorot(kind, amountAgorot))} ${PER.monthly})`;
  return text;
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
 * DLI-03: the deal form may leave the amount empty (sent as null): the database then fills it
 * from the product lines (0 while there are none). An import still needs it (no lines there).
 */
export const recurringSchema = makeRecurringSchema(false);
export const recurringFormSchema = makeRecurringSchema(true);

function makeRecurringSchema(emptyAmountFollowsLines: boolean) {
  return z
    .object({
      billing_kind: text,
      recurring_amount: text,
      recurring_start_date: text,
      renewal_date: text,
    })
    .transform((input, ctx): RecurringPatch => {
      const kind = (BILLING_KINDS as readonly string[]).includes(input.billing_kind) ? (input.billing_kind as BillingKind) : null;
      if (kind === null) {
        ctx.addIssue({
          code: "custom",
          path: ["billing_kind"],
          message: "יש לבחור סוג עסקה.",
        });
        return z.NEVER;
      }
      if (kind === "one_time") {
        return {
          billing_kind: null,
          recurring_amount_agorot: null,
          recurring_start_date: null,
          renewal_date: null,
        };
      }
      let ok = true;
      const amount = input.recurring_amount === "" ? null : parseMoneyToAgorot(input.recurring_amount);
      if (input.recurring_amount === "" && emptyAmountFollowsLines) {
        // the database fills it from the lines
      } else if (input.recurring_amount === "") {
        ctx.addIssue({
          code: "custom",
          path: ["recurring_amount"],
          message: kind === "monthly" ? "יש להזין סכום חודשי." : "יש להזין סכום שנתי.",
        });
        ok = false;
      } else if (amount === null) {
        ctx.addIssue({
          code: "custom",
          path: ["recurring_amount"],
          message: "יש להזין סכום בשקלים, למשל 1,200.",
        });
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
        ctx.addIssue({
          code: "custom",
          path: ["renewal_date"],
          message: "התאריך אינו תקין.",
        });
        ok = false;
      } else if (
        input.renewal_date !== "" &&
        isCalendarDate(input.recurring_start_date) &&
        input.renewal_date < input.recurring_start_date
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["renewal_date"],
          message: "תאריך החידוש לא יכול להיות לפני תאריך ההתחלה.",
        });
        ok = false;
      }
      if (!ok || (amount === null && !emptyAmountFollowsLines)) return z.NEVER;
      return {
        billing_kind: kind,
        recurring_amount_agorot: amount,
        recurring_start_date: input.recurring_start_date,
        renewal_date: input.renewal_date === "" ? null : input.renewal_date,
      };
    });
}

/** The value field as sent: null when it was left empty (the database then decides). */
export function typedDealValue(amountRaw: unknown, typedAgorot: number): number | null {
  return typeof amountRaw !== "string" || amountRaw.trim() === "" ? null : typedAgorot;
}
