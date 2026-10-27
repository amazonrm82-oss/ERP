import { z } from "zod";

import { formatMoney } from "@/lib/format";

// PAY-03 (lead's choices of 25 October 2026, asked of the owner): the customer's credit balance is every unallocated part of
// a recorded or confirmed payment of the same customer (PAY-02's rule); the database counts it
// (public.money_customer_credit) and allocates it to a new document (public.money_apply_credit). This file reads the answers
// and words them. Pure, unit tested.

const money = z.coerce.number().int().nonnegative();

const creditSchema = z.object({
  total: money,
  count: money,
  payments: z.array(z.object({ id: z.string(), paid_on: z.string(), method: z.string(), amount: money, credit: money })),
  // GAP-12: the customer's negative opening balances, with what each still holds (in `total` too)
  documents: z.array(z.object({ id: z.string(), doc_date: z.string(), credit: money })).optional().default([]),
});
export type CustomerCredit = z.infer<typeof creditSchema>;

export const NO_CREDIT: CustomerCredit = { total: 0, count: 0, payments: [], documents: [] };

/** The answer of public.money_customer_credit; a shape it does not know throws (FXC-12). */
export function parseCustomerCredit(raw: unknown): CustomerCredit {
  return creditSchema.parse(raw);
}

const appliedSchema = z.object({
  allocated: money,
  payments: z.array(z.object({ payment_id: z.string(), amount: money })),
  // GAP-12: the opening credits offset
  documents: z.array(z.object({ document_id: z.string(), amount: money })).optional().default([]),
});
export type AppliedCredit = z.infer<typeof appliedSchema>;

/** The answer of public.money_apply_credit. */
export function parseAppliedCredit(raw: unknown): AppliedCredit {
  return appliedSchema.parse(raw);
}

/** The line on a payments card: how much credit the customer holds, and in how many payments. */
export function creditLine(credit: Omit<CustomerCredit, "documents"> & { documents?: CustomerCredit["documents"] }): string | null {
  if (credit.total <= 0) return null;
  // GAP-12: an opening credit is part of the total
  const opening = (credit.documents ?? []).some((d) => d.credit > 0);
  if (credit.count === 0 && opening) return `ללקוח יתרת זכות של ${formatMoney(credit.total)} מיתרת הפתיחה, שעוד לא קוזזה.`;
  const from = credit.count === 1 ? "מתשלום אחד" : `מ-${credit.count} תשלומים`;
  return `ללקוח יתרת זכות של ${formatMoney(credit.total)} ${from}${opening ? " ומיתרת הפתיחה" : ""} שעוד לא שויכו למסמך.`;
}

/** The checkbox on the document form. */
export function applyCreditLabel(total: number): string {
  return `לקזז מיתרת הזכות של הלקוח (${formatMoney(total)})`;
}

/** What the document form says after saving. */
export function recordedMessage(applied: Omit<AppliedCredit, "documents"> | null, failed: boolean): string {
  if (failed) return "המסמך נרשם, אבל הקיזוז מיתרת הזכות לא הצליח. אפשר לשייך תשלום מהמסמך.";
  if (!applied || applied.allocated <= 0) return "המסמך נרשם.";
  return `המסמך נרשם, וקוזזו ${formatMoney(applied.allocated)} מיתרת הזכות של הלקוח.`;
}

/** GAP-12: what the card says after offsetting credit against an existing document. */
export function appliedCreditMessage(allocated: number): string {
  return `קוזזו ${formatMoney(allocated)} מיתרת הזכות של הלקוח.`;
}
