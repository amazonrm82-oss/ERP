import { z } from "zod";

import { isCalendarDate } from "@/lib/calendar-date";
import { parseMoneyToAgorot } from "@/lib/format";

// PAY-01, PAY-05: a payment received, recorded on a deal or a contact. Mirrors the checks of public.payments (migration
// payments); tests/unit/payments.test.ts reads the migration.

export const PAYMENT_METHODS = ["credit", "transfer", "cash", "cheque", "bit_paybox", "standing_order", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  credit: "כרטיס אשראי",
  transfer: "העברה בנקאית",
  cash: "מזומן",
  cheque: "צ'ק",
  bit_paybox: "Bit או PayBox",
  standing_order: "הוראת קבע",
  other: "אחר",
};

// SPEC-ADDITIONS 22.9: recorded, confirmed, failed, refunded; and cancelled (owner, 20 October 2026: a payment is never
// deleted, it is cancelled with a reason and then stays as it is)
export const PAYMENT_STATUSES = ["recorded", "confirmed", "failed", "refunded", "cancelled"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  recorded: "נרשם",
  confirmed: "אושר",
  failed: "נכשל",
  refunded: "הוחזר",
  cancelled: "בוטל",
};
/** A new payment starts recorded or confirmed (the table's trigger, hint payment:status). */
export const NEW_PAYMENT_STATUSES = ["recorded", "confirmed"] as const satisfies readonly PaymentStatus[];

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === "string" && (PAYMENT_METHODS as readonly string[]).includes(value);
}
export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return typeof value === "string" && (PAYMENT_STATUSES as readonly string[]).includes(value);
}

/**
 * PAY-06: the statuses a user may move a payment to. A recorder moves between recorded, confirmed and failed; marking it
 * refunded, or moving it back from refunded, is for owners and admins (the table's trigger, hint payment:correction).
 * Cancelling has its own window with a reason; a cancelled payment moves nowhere.
 */
export function statusChoices(current: PaymentStatus, isAdmin: boolean): PaymentStatus[] {
  if (current === "cancelled" || (current === "refunded" && !isAdmin)) return [];
  return PAYMENT_STATUSES.filter((status) => status !== current && status !== "cancelled" && (isAdmin || status !== "refunded"));
}

export const CANCEL_REASON_MAX = 500;
export const cancelReasonSchema = z
  .string()
  .trim()
  .min(1, { error: "יש לכתוב למה התשלום מבוטל." })
  .max(CANCEL_REASON_MAX, { error: `עד ${CANCEL_REASON_MAX} תווים.` });

export const PAYMENT_INSTALLMENTS_MAX = 36;
export const PAYMENT_REFERENCE_MAX = 100;
export const PAYMENT_NOTE_MAX = 1000;
// payments.amount_agorot
export const PAYMENT_AMOUNT_MAX = 1_000_000_000_000;

export const PAYMENT_FIELD_NAMES = ["amount", "paid_on", "method", "installments", "reference", "note"] as const;

const raw = z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string());

export const paymentSchema = z
  .object({
    amount: raw.transform((value, ctx) => {
      const agorot = value === "" ? null : parseMoneyToAgorot(value);
      if (agorot === null || agorot < 1 || agorot > PAYMENT_AMOUNT_MAX) {
        ctx.addIssue({
          code: "custom",
          message: "יש להזין את הסכום ששולם בשקלים, למשל 1,170.",
        });
        return z.NEVER;
      }
      return agorot;
    }),
    paid_on: raw.refine((value) => isCalendarDate(value), "יש לבחור את תאריך התשלום."),
    method: raw.refine(isPaymentMethod, "יש לבחור אמצעי תשלום.").transform((value) => value as PaymentMethod),
    installments: raw,
    reference: raw.pipe(
      z.string().max(PAYMENT_REFERENCE_MAX, {
        error: `האסמכתא עד ${PAYMENT_REFERENCE_MAX} תווים.`,
      }),
    ),
    note: raw.pipe(
      z.string().max(PAYMENT_NOTE_MAX, {
        error: `ההערה עד ${PAYMENT_NOTE_MAX} תווים.`,
      }),
    ),
  })
  .transform((value, ctx) => {
    // PAY-05: the number of instalments goes with a credit payment only (empty = one payment)
    let installments: number | null = null;
    if (value.method === "credit") {
      const text = value.installments === "" ? "1" : value.installments;
      const n = /^\d+$/.test(text) ? Number(text) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > PAYMENT_INSTALLMENTS_MAX) {
        ctx.addIssue({
          code: "custom",
          path: ["installments"],
          message: `מספר התשלומים בין 1 ל-${PAYMENT_INSTALLMENTS_MAX}.`,
        });
        return z.NEVER;
      }
      installments = n;
    }
    return {
      amount: value.amount,
      paid_on: value.paid_on,
      method: value.method,
      installments,
      reference: value.reference === "" ? null : value.reference,
      note: value.note === "" ? null : value.note,
    };
  });

export const newPaymentStatusSchema = z.enum(NEW_PAYMENT_STATUSES);
/** The statuses the status choice may send (cancelling goes through its own action, with a reason). */
export const paymentStatusSchema = z.enum(["recorded", "confirmed", "failed", "refunded"]);

/** The total of the payments that count as received (recorded or confirmed; never failed, refunded or cancelled), in agorot. */
export function receivedTotal(payments: readonly { amountAgorot: number; status: PaymentStatus }[]): number {
  return payments.reduce((sum, p) => (p.status === "recorded" || p.status === "confirmed" ? sum + p.amountAgorot : sum), 0);
}
