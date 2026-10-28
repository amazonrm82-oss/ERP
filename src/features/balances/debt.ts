import { z } from "zod";

// BAL-02: what public.customer_debt_summary answers and how the card words it. The database holds the rule (which
// documents owe, what is overdue); this file only reads and labels it. Pure, unit tested.

const money = z.coerce.number().int().nonnegative();

const summarySchema = z.union([
  z.object({ allowed: z.literal(false) }),
  // owner's answer (3) ב of BAL-01: some row of the customer is hidden from the user, so no figure of any kind
  z.object({ allowed: z.literal(true), partial: z.literal(true) }),
  z.object({
    allowed: z.literal(true),
    partial: z.literal(false),
    today: z.string(),
    open_debt: money,
    open_documents: money,
    overdue_debt: money,
    overdue_documents: money,
    oldest_due_date: z.string().nullable(),
    // BAL-03: the open debt by whole days late (business zone); `current` = not overdue yet
    aging: z.object({ current: money, d1_30: money, d31_60: money, d61_90: money, d91_plus: money }),
  }),
]);
export type DebtSummary = z.infer<typeof summarySchema>;
export type FullDebtSummary = Extract<DebtSummary, { partial: false }>;

/** The answer of public.customer_debt_summary; a shape it does not know throws (FXC-12). */
export function parseDebtSummary(raw: unknown): DebtSummary {
  return summarySchema.parse(raw);
}

/** BAL-02: a list row's open and overdue debt (the server-kept totals). */
export type DebtNumbers = { open: number; overdue: number };

/** Whole days between two calendar dates (YYYY-MM-DD), b - a. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** "מסמך אחד" / "3 מסמכים". */
export function documentsText(count: number): string {
  return count === 1 ? "מסמך אחד" : `${count} מסמכים`;
}

/** The overdue line's detail: how many documents and how late the oldest one is. */
export function overdueDetail(summary: FullDebtSummary): string | null {
  if (summary.overdue_documents === 0 || !summary.oldest_due_date) return null;
  const days = daysBetween(summary.oldest_due_date, summary.today);
  const late = days === 1 ? "יום אחד" : `${days} ימים`;
  return `${documentsText(summary.overdue_documents)}, הוותיק באיחור של ${late}`;
}

/**
 * BAL-03: the aging buckets in order, with their words. Age = whole days since the due date in the business's time zone;
 * a document is overdue from the day after its due date, so "0 עד 30" holds 1..30 days late, and what is not overdue yet
 * (due today or later, or with no due date) is its own bucket.
 */
export const AGING_BUCKETS = [
  { key: "current", label: "טרם הגיע מועד התשלום" },
  { key: "d1_30", label: "0 עד 30 יום באיחור" },
  { key: "d31_60", label: "31 עד 60 יום" },
  { key: "d61_90", label: "61 עד 90 יום" },
  { key: "d91_plus", label: "מעל 90 יום" },
] as const;
export type AgingKey = (typeof AGING_BUCKETS)[number]["key"];
export type Aging = Record<AgingKey, number>;

/** The buckets as rows with their share of the total (whole percent, null when there is no debt). */
export function agingRows(aging: Aging): Array<{ key: AgingKey; label: string; amount: number; percent: number | null }> {
  const total = AGING_BUCKETS.reduce((sum, b) => sum + aging[b.key], 0);
  return AGING_BUCKETS.map((b) => ({ key: b.key, label: b.label, amount: aging[b.key], percent: total > 0 ? Math.round((aging[b.key] / total) * 100) : null }));
}
