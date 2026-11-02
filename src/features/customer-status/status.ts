import { z } from "zod";

import type { BadgeTone } from "@/components/ui/badge";

// CON-11: a customer's status by its last purchase (a won deal), and its cumulative value. The database holds the rule
// (public.customer_summary, the computed fields customer_status / customer_value); this file mirrors the pure part
// (app.customer_status_rule, both run tests/unit/fixtures/customer-status.json) and words the answer. Pure, unit tested.

export const CUSTOMER_STATUSES = ["active", "dormant", "former"] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

/** The defaults when the business saved nothing (public.customer_status_settings has no row). */
export const DEFAULT_DORMANT_MONTHS = 6;
export const DEFAULT_FORMER_MONTHS = 18;
// the table's check constraints
export const DORMANT_MIN = 1;
export const DORMANT_MAX = 60;
export const FORMER_MIN = 2;
export const FORMER_MAX = 120;

export const CUSTOMER_STATUS_LABELS: Record<CustomerStatus, string> = {
  active: "לקוח פעיל",
  dormant: "לקוח רדום",
  former: "לקוח לשעבר",
};

/** The list filter's choices and the column's words (the stored codes of the computed field). */
export const CUSTOMER_STATUS_OPTIONS: Array<{ value: CustomerStatus; label: string }> = CUSTOMER_STATUSES.map((value) => ({
  value,
  label: CUSTOMER_STATUS_LABELS[value],
}));

export const CUSTOMER_STATUS_TONES: Record<CustomerStatus, BadgeTone> = {
  active: "success",
  dormant: "warning",
  former: "neutral",
};

export function isCustomerStatus(value: unknown): value is CustomerStatus {
  return typeof value === "string" && (CUSTOMER_STATUSES as readonly string[]).includes(value);
}

function parseDay(day: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return match ? { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) } : null;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** A calendar day plus whole months, clamped to the month's last day (PostgreSQL's date + interval 'n months'). */
export function addMonths(day: string, months: number): string {
  const parsed = parseDay(day);
  if (!parsed) throw new Error(`not a calendar day: ${day}`);
  const index = parsed.y * 12 + (parsed.m - 1) + months;
  const y = Math.floor(index / 12);
  const m = index - y * 12 + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${pad(y, 4)}-${pad(m)}-${pad(Math.min(parsed.d, last))}`;
}

/** app.customer_status_rule: active, then dormant from last + dormant months, then former from last + former months. */
export function customerStatusRule(last: string | null, today: string, dormantMonths: number, formerMonths: number): CustomerStatus | null {
  if (!last) return null;
  if (today >= addMonths(last, formerMonths)) return "former";
  if (today >= addMonths(last, dormantMonths)) return "dormant";
  return "active";
}

const count = z.coerce.number().int().nonnegative();
const money = z.coerce.number().int();
const months = z.coerce.number().int().positive();

const summarySchema = z.union([
  z.object({ allowed: z.literal(false) }),
  // BAL-01's partial rule: some won deal of the customer is hidden from the user, so no status and no value
  z.object({ allowed: z.literal(true), partial: z.literal(true) }),
  z.object({ allowed: z.literal(true), partial: z.literal(false), customer: z.literal(false), dormant_months: months, former_months: months }),
  z.object({
    allowed: z.literal(true),
    partial: z.literal(false),
    customer: z.literal(true),
    status: z.enum(CUSTOMER_STATUSES),
    deals: count,
    payments: count,
    deals_without_amount: count,
    value_agorot: money,
    first_purchase_on: z.string(),
    last_purchase_on: z.string(),
    dormant_on: z.string(),
    former_on: z.string(),
    today: z.string(),
    dormant_months: months,
    former_months: months,
  }),
]);
export type CustomerSummary = z.infer<typeof summarySchema>;
export type FullCustomerSummary = Extract<CustomerSummary, { customer: true }>;

/** The answer of public.customer_summary; a shape it does not know throws (FXC-12). */
export function parseCustomerSummary(raw: unknown): CustomerSummary {
  return summarySchema.parse(raw);
}

/** "עסקה אחת" / "3 עסקאות". */
export function dealsText(deals: number): string {
  return deals === 1 ? "עסקה אחת" : `${deals} עסקאות`;
}

/** The value's detail: what it sums (won deals only; a payment moves the last purchase, never the value). */
export function valueDetail(summary: { deals: number; payments: number }): string {
  if (summary.deals === 0) return "אין עסקה שנסגרה בהצלחה, רק תשלומים";
  return `${dealsText(summary.deals)} שנסגרו בהצלחה`;
}

/** "חודש" / "6 חודשים". */
export function monthsText(n: number): string {
  if (n === 1) return "חודש";
  if (n === 2) return "חודשיים";
  return `${n} חודשים`;
}

/** What the status means, in one line under the chip. */
export function statusExplanation(summary: FullCustomerSummary, formatDay: (day: string) => string = (day) => day): string {
  if (summary.status === "active") return `ייחשב רדום אם לא יקנה עד ${formatDay(summary.dormant_on)}`;
  if (summary.status === "dormant") return `לא קנה ${monthsText(summary.dormant_months)} ויותר`;
  return `לא קנה ${monthsText(summary.former_months)} ויותר`;
}

/** The settings form's check, the same as the table's constraints. Null = valid, else the Hebrew problem per field. */
export function thresholdProblems(dormant: number, former: number): { dormant_months?: string; former_months?: string } | null {
  const problems: { dormant_months?: string; former_months?: string } = {};
  if (!Number.isInteger(dormant) || dormant < DORMANT_MIN || dormant > DORMANT_MAX) {
    problems.dormant_months = `מספר שלם בין ${DORMANT_MIN} ל-${DORMANT_MAX}.`;
  }
  if (!Number.isInteger(former) || former < FORMER_MIN || former > FORMER_MAX) {
    problems.former_months = `מספר שלם בין ${FORMER_MIN} ל-${FORMER_MAX}.`;
  } else if (!problems.dormant_months && former <= dormant) {
    problems.former_months = "צריך להיות יותר מהחודשים עד לקוח רדום.";
  }
  return Object.keys(problems).length > 0 ? problems : null;
}
