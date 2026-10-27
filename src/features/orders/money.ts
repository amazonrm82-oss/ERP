import { z } from "zod";

import type { BadgeTone } from "@/components/ui/badge";

// ORD-02 (the rest) / ORD-04 (the rest): an order's billing and payment status and how much of it, and of each schedule step,
// is billed and paid. Worked out in the database (public.order_money_state, migration order_money_state, security invoker:
// RLS decides what counts); this file only parses and words it. Billed = active tax invoices and tax invoice-receipts less
// credit invoices linked to the order; paid = its recorded or confirmed payments; a proforma is a payment request only.

export const BILLING_STATES = ["not_billed", "partly_billed", "billed"] as const;
export type BillingState = (typeof BILLING_STATES)[number];
export const PAYMENT_STATES = ["unpaid", "partly_paid", "paid"] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export const BILLING_STATE_LABELS: Record<BillingState | "unknown", string> = {
  not_billed: "לא חויבה",
  partly_billed: "חויבה חלקית",
  billed: "חויבה",
  unknown: "חיוב: לא ידוע",
};
export const PAYMENT_STATE_LABELS: Record<PaymentState | "unknown", string> = {
  unpaid: "לא שולמה",
  partly_paid: "שולמה חלקית",
  paid: "שולמה",
  unknown: "תשלום: לא ידוע",
};

const TONES: Record<string, BadgeTone> = {
  billed: "success",
  paid: "success",
  partly_billed: "warning",
  partly_paid: "warning",
};

export function moneyStateTone(state: string): BadgeTone {
  return TONES[state] ?? "neutral";
}

export function isBillingState(value: unknown): value is BillingState {
  return typeof value === "string" && (BILLING_STATES as readonly string[]).includes(value);
}

export function isPaymentState(value: unknown): value is PaymentState {
  return typeof value === "string" && (PAYMENT_STATES as readonly string[]).includes(value);
}

const amount = z.coerce.number().int();
const nullableAmount = amount.nullable();

const stepSchema = z.object({ id: z.string(), amount, billed: nullableAmount, paid: nullableAmount });
const orderSchema = z.object({
  id: z.string(),
  total: amount,
  partial: z.boolean(),
  billed: nullableAmount,
  paid: nullableAmount,
  requested: nullableAmount,
  billing_state: z.enum([...BILLING_STATES, "unknown"]).nullable(),
  payment_state: z.enum([...PAYMENT_STATES, "unknown"]).nullable(),
  steps: z.array(stepSchema),
});
const resultSchema = z.object({ orders: z.array(orderSchema) });

export type OrderMoneyStep = { id: string; amountAgorot: number; billedAgorot: number | null; paidAgorot: number | null };
export type OrderMoney = {
  id: string;
  totalAgorot: number;
  // the caller does not read every document or payment of the order: nothing is worked out
  partial: boolean;
  billedAgorot: number | null;
  paidAgorot: number | null;
  requestedAgorot: number | null;
  // null for a draft
  billingState: BillingState | "unknown" | null;
  paymentState: PaymentState | "unknown" | null;
  steps: OrderMoneyStep[];
};

/** public.order_money_state's answer, by order id; throws on a shape the code does not know. */
export function parseOrderMoney(value: unknown): Map<string, OrderMoney> {
  const parsed = resultSchema.parse(value);
  return new Map(
    parsed.orders.map((o) => [
      o.id,
      {
        id: o.id,
        totalAgorot: o.total,
        partial: o.partial,
        billedAgorot: o.billed,
        paidAgorot: o.paid,
        requestedAgorot: o.requested,
        billingState: o.billing_state,
        paymentState: o.payment_state,
        steps: o.steps.map((s) => ({ id: s.id, amountAgorot: s.amount, billedAgorot: s.billed, paidAgorot: s.paid })),
      },
    ]),
  );
}

/** What is left to bill and to pay (never below zero), and what was billed or paid beyond the total. */
export function moneyRemainders(money: Pick<OrderMoney, "totalAgorot" | "billedAgorot" | "paidAgorot">): {
  toBill: number | null;
  toPay: number | null;
  overBilled: number;
  overPaid: number;
} {
  const { totalAgorot: total, billedAgorot: billed, paidAgorot: paid } = money;
  return {
    toBill: billed === null ? null : Math.max(total - billed, 0),
    toPay: paid === null ? null : Math.max(total - paid, 0),
    overBilled: billed === null ? 0 : Math.max(billed - total, 0),
    overPaid: paid === null ? 0 : Math.max(paid - total, 0),
  };
}

export type StepState = "paid" | "partly_paid" | "billed" | "partly_billed" | "open" | "unknown";

export const STEP_STATE_LABELS: Record<StepState, string> = {
  paid: "שולם",
  partly_paid: "שולם חלקית",
  billed: "חויב, לא שולם",
  partly_billed: "חויב חלקית",
  open: "פתוח",
  unknown: "לא ידוע",
};

/** One schedule step: paid wins over billed; a step of zero is open until money covers anything beyond it. */
export function stepState(step: OrderMoneyStep): StepState {
  if (step.billedAgorot === null || step.paidAgorot === null) return "unknown";
  if (step.amountAgorot > 0 && step.paidAgorot >= step.amountAgorot) return "paid";
  if (step.paidAgorot > 0) return "partly_paid";
  if (step.amountAgorot > 0 && step.billedAgorot >= step.amountAgorot) return "billed";
  if (step.billedAgorot > 0) return "partly_billed";
  return "open";
}

/** The list filter's values, read from the address; anything else is left out. */
export function moneyFilterValue<T extends string>(value: string | undefined, allowed: readonly T[]): T | null {
  return value !== undefined && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}
