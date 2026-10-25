import { z } from "zod";

import { isCalendarDate } from "@/lib/calendar-date";

import type { PaymentStatus } from "./schema";

// PAY-04 (owner, 21 October 2026): cheques. Each cheque is its own payment; its status sets the payment's. Mirrors
// app.cheque_bank_codes() and app.cheque_payment_status() of migration cheques (tests/unit/cheques.test.ts reads it).

// Bank of Israel bank codes (the two-digit bank numbers of the Bank of Israel's list of banks in Israel), one place only
export const ISRAELI_BANKS: ReadonlyArray<{ code: string; name: string }> = [
  { code: "04", name: "בנק יהב" },
  { code: "09", name: "בנק הדואר" },
  { code: "10", name: "בנק לאומי" },
  { code: "11", name: "בנק דיסקונט" },
  { code: "12", name: "בנק הפועלים" },
  { code: "13", name: "בנק אגוד" },
  { code: "14", name: "בנק אוצר החייל" },
  { code: "17", name: "בנק מרכנתיל דיסקונט" },
  { code: "18", name: "One Zero" },
  { code: "20", name: "בנק מזרחי טפחות" },
  { code: "22", name: "Citibank" },
  { code: "23", name: "HSBC" },
  { code: "26", name: "יובנק" },
  { code: "31", name: "הבנק הבינלאומי" },
  { code: "34", name: "בנק ערבי ישראלי" },
  { code: "46", name: "בנק מסד" },
  { code: "52", name: "בנק פועלי אגודת ישראל" },
  { code: "54", name: "בנק ירושלים" },
];
export const OTHER_BANK = "other";
export const OTHER_BANK_LABEL = "אחר (בנק בחו\"ל)";

export function bankLabel(code: string | null, otherName: string | null): string | null {
  if (!code) return null;
  if (code === OTHER_BANK) return otherName ?? "בנק אחר";
  const bank = ISRAELI_BANKS.find((b) => b.code === code);
  return bank ? `${bank.name} (${bank.code})` : code;
}

export const CHEQUE_STATUSES = ["in_hand", "deposited", "cleared", "bounced"] as const;
export type ChequeStatus = (typeof CHEQUE_STATUSES)[number];
export const CHEQUE_STATUS_LABELS: Record<ChequeStatus, string> = {
  in_hand: "ביד",
  deposited: "הופקד",
  cleared: "נפרע",
  bounced: "חזר",
};
export function isChequeStatus(value: unknown): value is ChequeStatus {
  return typeof value === "string" && (CHEQUE_STATUSES as readonly string[]).includes(value);
}

/** Answer 2: the payment status a cheque status means. */
export function chequePaymentStatus(status: ChequeStatus): PaymentStatus {
  return status === "cleared" ? "confirmed" : status === "bounced" ? "failed" : "recorded";
}

/** The cheque statuses a user may move a cheque to: out of "bounced" only owners and admins (answer 4). */
export function chequeStatusChoices(current: ChequeStatus, isAdmin: boolean): ChequeStatus[] {
  if (current === "bounced" && !isAdmin) return [];
  return CHEQUE_STATUSES.filter((s) => s !== current);
}

export const CHEQUE_NUMBER_MAX = 20;
export const CHEQUE_BANK_NAME_MAX = 80;
export const UNBOUNCE_REASON_MAX = 500;
// the lead's call 3: a series of at most 36 cheques
export const CHEQUE_SERIES_MAX = 36;

export const CHEQUE_FIELD_NAMES = ["cheque_number", "cheque_bank", "cheque_bank_name", "cheque_branch", "cheque_due_date", "cheque_status"] as const;

const raw = z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string());

export type ChequeFields = {
  cheque_number: string;
  cheque_bank: string;
  cheque_bank_name: string | null;
  cheque_branch: string | null;
  cheque_due_date: string;
  cheque_status: ChequeStatus;
};

const bankCodes = new Set(ISRAELI_BANKS.map((b) => b.code));

/** A cheque's details from the form (answer 5: a listed bank and a 3-digit branch, or "other" with the bank's name). */
export const chequeSchema = z
  .object({
    cheque_number: raw.refine((v) => /^\d{1,20}$/.test(v), `מספר הצ'ק: ספרות בלבד, עד ${CHEQUE_NUMBER_MAX}.`),
    cheque_bank: raw.refine((v) => v === OTHER_BANK || bankCodes.has(v), "יש לבחור בנק."),
    cheque_bank_name: raw.pipe(z.string().max(CHEQUE_BANK_NAME_MAX, { error: `שם הבנק עד ${CHEQUE_BANK_NAME_MAX} תווים.` })),
    cheque_branch: raw,
    cheque_due_date: raw.refine((v) => isCalendarDate(v), "יש לבחור את תאריך הפירעון."),
    cheque_status: raw.refine(isChequeStatus, "יש לבחור את מצב הצ'ק.").transform((v) => v as ChequeStatus),
  })
  .transform((value, ctx): ChequeFields => {
    const other = value.cheque_bank === OTHER_BANK;
    if (other && value.cheque_bank_name === "") {
      ctx.addIssue({ code: "custom", path: ["cheque_bank_name"], message: "יש לכתוב את שם הבנק." });
      return z.NEVER;
    }
    if (!other && !/^\d{3}$/.test(value.cheque_branch)) {
      ctx.addIssue({ code: "custom", path: ["cheque_branch"], message: "מספר הסניף: 3 ספרות." });
      return z.NEVER;
    }
    if (other && value.cheque_branch !== "" && !/^\d{3}$/.test(value.cheque_branch)) {
      ctx.addIssue({ code: "custom", path: ["cheque_branch"], message: "מספר הסניף: 3 ספרות, או להשאיר ריק." });
      return z.NEVER;
    }
    return {
      cheque_number: value.cheque_number,
      cheque_bank: value.cheque_bank,
      cheque_bank_name: other ? value.cheque_bank_name : null,
      cheque_branch: value.cheque_branch === "" ? null : value.cheque_branch,
      cheque_due_date: value.cheque_due_date,
      cheque_status: value.cheque_status,
    };
  });

export const unbounceReasonSchema = z
  .string()
  .trim()
  .min(1, { error: "יש לכתוב למה הצ'ק חוזר ממצב \"חזר\"." })
  .max(UNBOUNCE_REASON_MAX, { error: `עד ${UNBOUNCE_REASON_MAX} תווים.` });

/** Adds whole months to a calendar day, clamped to the month's last day (31 January + 1 month = 28 or 29 February). */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** Adds days to a calendar day. */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * A series' cheques (answer 1): the first number then +1 each (keeping leading zeros), the first due date then every month
 * (always from the first, so 31st stays the month's end) or every N days. Null when the numbers would pass 20 digits.
 */
export function chequeSeries(
  first: { number: string; dueDate: string },
  count: number,
  step: { kind: "month" } | { kind: "days"; days: number },
): { number: string; dueDate: string }[] | null {
  const width = first.number.length;
  const start = BigInt(first.number);
  const out: { number: string; dueDate: string }[] = [];
  for (let i = 0; i < count; i++) {
    const number = (start + BigInt(i)).toString().padStart(width, "0");
    if (number.length > CHEQUE_NUMBER_MAX) return null;
    const dueDate = step.kind === "month" ? addMonths(first.dueDate, i) : addDays(first.dueDate, i * step.days);
    out.push({ number, dueDate });
  }
  return out;
}

/** Answer 7: the deferred cheques due from today through the next 30 days (inclusive), in agorot. */
export function next30DaysTotal(cheques: readonly { dueDate: string; amountAgorot: number }[], today: string): number {
  const end = addDays(today, 30);
  return cheques.reduce((sum, c) => (c.dueDate >= today && c.dueDate <= end ? sum + c.amountAgorot : sum), 0);
}
