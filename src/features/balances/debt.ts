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
