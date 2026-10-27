import { z } from "zod";

import { DOCUMENT_TYPE_LABELS, documentTitle, isDocumentType, isOpeningBalance } from "@/features/documents/schema";
import { isPaymentMethod, isPaymentStatus, PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS } from "@/features/payments/schema";
import { isCalendarDate } from "@/lib/calendar-date";

// BAL-01: what public.customer_ledger answers and how the screen words it. The database holds the rule (which lines are
// a debit, a credit, or neither); this file only reads and labels it. Pure, unit tested.

const money = z.coerce.number().int();

// A line as both views give it; the full view adds the running balance.
const baseLineSchema = z.object({
  kind: z.enum(["document", "payment"]),
  id: z.string(),
  date: z.string(),
  type: z.string(),
  label: z.string().nullable(),
  status: z.string(),
  invoice_number: z.string().nullable(),
  // a tax invoice that bills a proforma: the proforma's number (the invoice's line carries only the difference)
  proforma_number: z.string().nullable(),
  amount: money,
  debit: money,
  credit: money,
});
export type LedgerLine = z.infer<typeof baseLineSchema>;
const fullLineSchema = baseLineSchema.extend({ balance: money });
export type FullLedgerLine = z.infer<typeof fullLineSchema>;

const ledgerSchema = z.union([
  z.object({ allowed: z.literal(false) }),
  // every row of the customer is readable: balances and totals
  z.object({
    allowed: z.literal(true),
    partial: z.literal(false),
    from: z.string(),
    to: z.string(),
    opening: money,
    shown_opening: money,
    truncated: z.boolean(),
    debit: money,
    credit: money,
    closing: money,
    open_debt: money,
    credit_balance: money,
    lines: z.array(fullLineSchema),
  }),
  // owner's answer (3) ב: some row is hidden from the user, so only the lines they read and no balance of any kind
  z.object({
    allowed: z.literal(true),
    partial: z.literal(true),
    from: z.string(),
    to: z.string(),
    truncated: z.boolean(),
    lines: z.array(baseLineSchema),
  }),
]);
export type Ledger = z.infer<typeof ledgerSchema>;

/** The words the card shows when some of the customer's rows are hidden from the user (and no balance). */
export const LEDGER_PARTIAL_TEXT = "חלק מהשורות מוסתרות";

/** What the card shows of a ledger: nothing, the lines only (partial), or the lines with every balance. */
export function ledgerView(ledger: Ledger): "hidden" | "partial" | "full" {
  if (!ledger.allowed) return "hidden";
  return ledger.partial ? "partial" : "full";
}

/** The answer of public.customer_ledger; a shape it does not know throws (FXC-12). */
export function parseLedger(raw: unknown): Ledger {
  return ledgerSchema.parse(raw);
}

/** The same day a year back (29 February becomes the 28th), for the default period of the last 12 months. */
export function yearBefore(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const year = y - 1;
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return `${year}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** The period from the page's address (`lf`, `lt`), else the last 12 months up to today; a reversed one is swapped. */
export function ledgerPeriod(today: string, from?: string | null, to?: string | null): { from: string; to: string } {
  const end = to && isCalendarDate(to) ? to : today;
  const start = from && isCalendarDate(from) ? from : yearBefore(end);
  return start <= end ? { from: start, to: end } : { from: end, to: start };
}

/** What a line is, in words: the document's type and number, or the payment's method and reference. */
export function lineTitle(line: LedgerLine): string {
  if (line.kind === "document") {
    // GAP-12: an opening balance has no number; it is named by its date
    if (isDocumentType(line.type) && isOpeningBalance(line.type)) return documentTitle({ docType: line.type, number: null, docDate: line.date });
    const type = isDocumentType(line.type) ? DOCUMENT_TYPE_LABELS[line.type] : line.type;
    return line.label ? `${type} ${line.label}` : type;
  }
  const method = isPaymentMethod(line.type) ? PAYMENT_METHOD_LABELS[line.type] : line.type;
  return line.label ? `תשלום · ${method} · ${line.label}` : `תשלום · ${method}`;
}

/** Why a line has no effect on the balance or only part of it (a billed proforma, the invoice that replaced it); null otherwise. */
export function lineNote(line: LedgerLine): string | null {
  if (line.kind === "document") {
    if (line.status === "cancelled") return "בוטל, לא נספר";
    if (line.type === "proforma" && line.invoice_number) return `הועבר לחשבונית מס ${line.invoice_number}`;
    if (line.type === "tax_invoice" && line.proforma_number) return `במקום חשבון עסקה ${line.proforma_number}: נספר רק ההפרש`;
    if (line.type === "receipt") return "אישור תשלום, בלי סכום ביתרה";
    return null;
  }
  if (line.status === "recorded" || line.status === "confirmed") return null;
  return isPaymentStatus(line.status) ? `${PAYMENT_STATUS_LABELS[line.status]}, לא נספר` : "לא נספר";
}

/** A line that shows greyed: it moves nothing (a cancelled or failed row, a receipt, an invoice equal to the proforma it bills). */
export function lineMuted(line: LedgerLine): boolean {
  return line.debit === 0 && line.credit === 0;
}
