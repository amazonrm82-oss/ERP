import { z } from "zod";

import type { BadgeTone } from "@/components/ui/badge";

// PAY-02 (owner, 21 October 2026): what public.money_allocation_state answers for documents and payments, and how the screen
// names it. The database holds the rule; this file only reads and labels it. Pure, unit tested.

export const DOCUMENT_PAYMENT_STATES = ["unpaid", "partial", "paid", "transferred", "paid_on_issue", "none"] as const;
export type DocumentPaymentState = (typeof DOCUMENT_PAYMENT_STATES)[number];

const money = z.coerce.number().int().nonnegative();

const stateSchema = z.object({
  documents: z.array(
    z.object({
      id: z.string(),
      paid: money,
      balance: money,
      state: z.enum(DOCUMENT_PAYMENT_STATES),
      invoice_number: z.string().nullable(),
    }),
  ),
  payments: z.array(z.object({ id: z.string(), allocated: money, credit: money })),
});

export type DocumentMoneyState = { paid: number; balance: number; state: DocumentPaymentState; invoiceNumber: string | null };
export type PaymentMoneyState = { allocated: number; credit: number };

/** The answer of public.money_allocation_state, by id; a shape it does not know throws (FXC-12). */
export function parseMoneyState(raw: unknown): { documents: Map<string, DocumentMoneyState>; payments: Map<string, PaymentMoneyState> } {
  const parsed = stateSchema.parse(raw);
  return {
    documents: new Map(parsed.documents.map((d) => [d.id, { paid: d.paid, balance: d.balance, state: d.state, invoiceNumber: d.invoice_number }])),
    payments: new Map(parsed.payments.map((p) => [p.id, { allocated: p.allocated, credit: p.credit }])),
  };
}

/** The chip a document shows next to its amount; null where it has no balance (a receipt, a credit invoice, a cancelled one). */
export function documentStateChip(state: DocumentMoneyState): { label: string; tone: BadgeTone } | null {
  switch (state.state) {
    case "unpaid":
      return { label: "לא שולם", tone: "warning" };
    case "partial":
      return { label: "שולם חלקית", tone: "accent" };
    case "paid":
    case "paid_on_issue":
      return { label: "שולם", tone: "success" };
    case "transferred":
      return { label: state.invoiceNumber ? `הועבר לחשבונית ${state.invoiceNumber}` : "הועבר לחשבונית", tone: "neutral" };
    case "none":
      return null;
  }
}

/** Whether a document still takes payments (an open tax invoice or proforma with a balance). */
export function takesPayments(state: DocumentMoneyState | undefined): boolean {
  return state !== undefined && (state.state === "unpaid" || state.state === "partial") && state.balance > 0;
}

const candidatesSchema = z.object({
  documents: z.array(z.object({ id: z.string(), doc_type: z.string(), number: z.string(), doc_date: z.string(), amount: money, balance: money })),
  payments: z.array(z.object({ id: z.string(), paid_on: z.string(), method: z.string(), amount: money, credit: money })),
  proformas: z.array(z.object({ id: z.string(), number: z.string(), doc_date: z.string(), amount: money })),
});
export type AllocationCandidates = z.infer<typeof candidatesSchema>;

/** The answer of public.money_allocation_candidates. */
export function parseCandidates(raw: unknown): AllocationCandidates {
  return candidatesSchema.parse(raw);
}

/**
 * The amount offered in the window for one candidate: what is left to allocate, capped by what the candidate can take, in
 * the order shown (the earliest first), so the default never passes either side.
 */
export function defaultSplit(available: number, rooms: number[]): number[] {
  let left = Math.max(available, 0);
  return rooms.map((room) => {
    const take = Math.min(left, Math.max(room, 0));
    left -= take;
    return take;
  });
}
