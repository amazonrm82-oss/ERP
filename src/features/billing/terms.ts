// CON-08: a customer's payment terms. Stored on companies and contacts as
// payment_terms + payment_days (migration billing_details, constraint *_payment_terms_shape):
//   immediate  מיידי: due on the document date (no days)
//   net        N days after the document date
//   eom        שוטף+N: N days after the last day of the document's month (שוטף = שוטף+0)
// COL-02 computes a document's due date with paymentDueDate() / app.payment_due_date().

import { isCalendarDate } from "@/lib/calendar-date";

export const PAYMENT_TERMS = ["immediate", "net", "eom"] as const;
export type PaymentTermsKind = (typeof PAYMENT_TERMS)[number];

export const PAYMENT_DAYS_MAX = 365;

export type PaymentTerms = { kind: PaymentTermsKind; days: number | null };

/** The kinds as the terms select offers them. */
export const PAYMENT_TERMS_LABELS: Record<PaymentTermsKind, string> = {
  immediate: "מיידי",
  eom: "שוטף+ימים",
  net: "ימים מתאריך המסמך",
};

/** The shortcuts above the terms field (owner, 14 October 2026): a click fills the kind and N. */
export const PAYMENT_TERMS_SHORTCUTS: readonly PaymentTerms[] = [
  { kind: "immediate", days: null },
  { kind: "eom", days: 0 },
  { kind: "eom", days: 30 },
  { kind: "eom", days: 60 },
  { kind: "eom", days: 90 },
];

export function isPaymentTermsKind(value: unknown): value is PaymentTermsKind {
  return typeof value === "string" && (PAYMENT_TERMS as readonly string[]).includes(value);
}

/** The stored pair as terms, or null when it is not set or not a shape the database allows. */
export function paymentTermsOf(kind: string | null | undefined, days: number | null | undefined): PaymentTerms | null {
  if (!isPaymentTermsKind(kind)) return null;
  if (kind === "immediate") return days === null || days === undefined ? { kind, days: null } : null;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > PAYMENT_DAYS_MAX) return null;
  return { kind, days };
}

/**
 * The terms as the card and the documents show them (owner, 14 October 2026):
 * "מיידי", "שוטף" (= שוטף+0), "שוטף+45", "30 יום מתאריך המסמך" ("יום" for every N),
 * "ביום המסמך" (= 0 days after the document date).
 */
export function paymentTermsText(terms: PaymentTerms | null): string | null {
  if (!terms) return null;
  if (terms.kind === "immediate") return "מיידי";
  const days = terms.days ?? 0;
  if (terms.kind === "eom") return days === 0 ? "שוטף" : `שוטף+${days}`;
  return days === 0 ? "ביום המסמך" : `${days} יום מתאריך המסמך`;
}

/** Thrown by paymentDueDate() for terms the database would refuse (SQL: 22023, hint payment_terms:invalid). */
export class PaymentTermsError extends RangeError {
  readonly hint = "payment_terms:invalid";
  constructor() {
    super("payment terms are invalid");
    this.name = "PaymentTermsError";
  }
}

// "YYYY-MM-DD" of a UTC date, or null past 9999-12-31 (where app.payment_due_date refuses too)
function dayOf(date: Date): string | null {
  return date.getUTCFullYear() > 9999 ? null : date.toISOString().slice(0, 10);
}

// setUTCFullYear, not Date.UTC: Date.UTC maps the years 0..99 to 1900..1999
function utcDate(year: number, monthIndex: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  return date;
}

function addDays(day: string, n: number): string | null {
  const date = utcDate(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + n);
  return dayOf(date);
}

function endOfMonth(day: string): string {
  // day 0 of the next month is the last day of this one
  return utcDate(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0).toISOString().slice(0, 10);
}

/**
 * The due date ("YYYY-MM-DD") of a document dated `documentDay` under these terms: the one rule,
 * mirrored by app.payment_due_date() (migration payment_due_date; tests/db/105 compares them day by
 * day). Gregorian calendar, rest days are not skipped. immediate = the document date; net = date + N;
 * eom = last day of the document's month + N. An unknown kind, N missing or outside 0..365 for net/eom,
 * N given for immediate, a day that is not a real date of the years 0001..9999, or a due date past
 * 9999-12-31 throws PaymentTermsError.
 */
export function paymentDueDate(documentDay: string, terms: { kind: string; days: number | null | undefined }): string {
  if (!isCalendarDate(documentDay) || documentDay < "0001-01-01" || !isPaymentTermsKind(terms.kind)) throw new PaymentTermsError();
  const days = terms.days ?? null;
  if (terms.kind === "immediate") {
    if (days !== null) throw new PaymentTermsError();
    return documentDay;
  }
  if (days === null || !Number.isInteger(days) || days < 0 || days > PAYMENT_DAYS_MAX) throw new PaymentTermsError();
  const due = terms.kind === "eom" ? addDays(endOfMonth(documentDay), days) : addDays(documentDay, days);
  if (due === null) throw new PaymentTermsError();
  return due;
}
