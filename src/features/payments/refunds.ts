import { z } from "zod";

import { isCalendarDate } from "@/lib/calendar-date";
import { parseMoneyToAgorot } from "@/lib/format";

import { CANCEL_REASON_MAX, isPaymentMethod, PAYMENT_AMOUNT_MAX, PAYMENT_NOTE_MAX, PAYMENT_REFERENCE_MAX, type PaymentMethod, type PaymentStatus } from "./schema";

// PAY-08 (owner's answer (71) ב, 3 November 2026): a refund is its own record on the payment it returns money from (migration
// payment_refunds). Partial refunds are allowed; the active refunds never sum to more than the payment; the payment counts its
// amount less its active refunds; refunded in full = the payment's status "הוחזר". Owners and admins only; never deleted,
// cancelled with a reason. Pure, unit tested.

export const REFUND_STATUSES = ["active", "cancelled"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export type Refund = {
  id: string;
  paymentId: string;
  amountAgorot: number;
  refundedOn: string;
  method: PaymentMethod;
  reference: string | null;
  note: string | null;
  creditDocumentId: string | null;
  status: RefundStatus;
  cancelReason: string | null;
  cancelledAt: string | null;
  createdBy: string | null;
};

export const REFUND_FIELD_NAMES = ["amount", "refunded_on", "method", "reference", "note", "credit_document_id"] as const;

const raw = z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string());

export const refundSchema = z.object({
  amount: raw.transform((value, ctx) => {
    const agorot = value === "" ? null : parseMoneyToAgorot(value);
    if (agorot === null || agorot < 1 || agorot > PAYMENT_AMOUNT_MAX) {
      ctx.addIssue({ code: "custom", message: "יש להזין את הסכום שהוחזר בשקלים, למשל 300." });
      return z.NEVER;
    }
    return agorot;
  }),
  refunded_on: raw.refine((value) => isCalendarDate(value), "יש לבחור את תאריך ההחזר."),
  method: raw.refine(isPaymentMethod, "יש לבחור איך הוחזר הכסף.").transform((value) => value as PaymentMethod),
  reference: raw
    .pipe(z.string().max(PAYMENT_REFERENCE_MAX, { error: `האסמכתא עד ${PAYMENT_REFERENCE_MAX} תווים.` }))
    .transform((value) => (value === "" ? null : value)),
  note: raw.pipe(z.string().max(PAYMENT_NOTE_MAX, { error: `ההערה עד ${PAYMENT_NOTE_MAX} תווים.` })).transform((value) => (value === "" ? null : value)),
  credit_document_id: raw
    .refine((value) => value === "" || z.guid().safeParse(value).success, "יש לבחור חשבונית זיכוי מהרשימה.")
    .transform((value) => (value === "" ? null : value)),
});

export const refundCancelSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, { error: "יש לכתוב למה ההחזר מבוטל." })
    .max(CANCEL_REASON_MAX, { error: `עד ${CANCEL_REASON_MAX} תווים.` }),
});

/** The sum of a payment's active refunds, in agorot. */
export function refundedTotal(refunds: readonly Pick<Refund, "amountAgorot" | "status">[]): number {
  return refunds.reduce((sum, r) => (r.status === "active" ? sum + r.amountAgorot : sum), 0);
}

/** What a payment counts for (public.payment_counted): recorded or confirmed, its amount less its active refunds; else 0. */
export function countedAmount(payment: { amountAgorot: number; status: PaymentStatus }, refunded: number): number {
  return payment.status === "recorded" || payment.status === "confirmed" ? Math.max(payment.amountAgorot - refunded, 0) : 0;
}

/** How much may still be refunded from a payment: only a recorded or confirmed one, up to what its refunds left. */
export function refundable(payment: { amountAgorot: number; status: PaymentStatus }, refunded: number): number {
  return countedAmount(payment, refunded);
}

/** The line under a payment that was partly or wholly refunded by its records; null when nothing stands. */
export function refundedLine(payment: { amountAgorot: number; status: PaymentStatus }, refunded: number): string | null {
  if (refunded <= 0) return null;
  return refunded >= payment.amountAgorot ? "הוחזר במלואו" : "הוחזר חלקית";
}
