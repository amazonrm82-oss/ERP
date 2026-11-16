import { z } from "zod";

import { isCalendarDate } from "@/lib/calendar-date";
import { parseMoneyToAgorot } from "@/lib/format";

// LNK-02: the form of a new payment link and the words of its states. The database judges the rest (the source still open,
// the amount at most what is open, who may, the plan keys): app.payment_links_check.

export const PAYMENT_LINK_SOURCE_KINDS = ["quote", "order", "document", "contact"] as const;
export type PaymentLinkSourceKind = (typeof PAYMENT_LINK_SOURCE_KINDS)[number];
export type PaymentLinkSource = { kind: PaymentLinkSourceKind; id: string };

/** The column of `payment_links` that names each kind of source. */
export const SOURCE_COLUMN = {
  quote: "quote_id",
  order: "order_id",
  document: "accounting_document_id",
  contact: "contact_id",
} as const satisfies Record<PaymentLinkSourceKind, string>;

export const PAYMENT_LINK_STATUSES = ["pending", "paid", "failed", "expired", "cancelled"] as const;
export type PaymentLinkStatus = (typeof PAYMENT_LINK_STATUSES)[number];

export const PAYMENT_LINK_STATUS_LABELS: Record<PaymentLinkStatus, string> = {
  pending: "ממתין לתשלום",
  paid: "שולם",
  failed: "התשלום נכשל",
  expired: "פג תוקף",
  cancelled: "בוטל",
};

export const PAYMENT_LINK_AMOUNT_MAX = 1_000_000_000_000;
export const PAYMENT_LINK_INSTALLMENTS_MAX = 36;
// the last day: today up to 90 days ahead (in the business zone); a new link is offered with 14
export const PAYMENT_LINK_DAYS_MAX = 90;
export const PAYMENT_LINK_DAYS_DEFAULT = 14;
// pending links per source (the database's cap, hint payment_link:max)
export const PAYMENT_LINK_PENDING_MAX = 20;

/** A pending link whose last day has passed shows as expired at once, before the job marks it (every 15 minutes). */
export function effectiveLinkStatus(status: string, expiresAt: string, now: Date = new Date()): PaymentLinkStatus {
  const known = (PAYMENT_LINK_STATUSES as readonly string[]).includes(status) ? (status as PaymentLinkStatus) : "expired";
  if (known === "pending" && Date.parse(expiresAt) <= now.getTime()) return "expired";
  return known;
}

/** A calendar day (YYYY-MM-DD) plus whole days, without time zones. */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d + days));
  return at.toISOString().slice(0, 10);
}

const raw = z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string());

/** The fields of a new link; `today` is the business's day, so the last day is judged as the database judges it. */
export function paymentLinkSchema(today: string) {
  const last = addDays(today, PAYMENT_LINK_DAYS_MAX);
  return z.object({
    amount: raw.transform((value, ctx) => {
      const agorot = value === "" ? null : parseMoneyToAgorot(value);
      if (agorot === null || agorot < 1 || agorot > PAYMENT_LINK_AMOUNT_MAX) {
        ctx.addIssue({ code: "custom", message: "יש להזין סכום לתשלום בשקלים, למשל 1,170." });
        return z.NEVER;
      }
      return agorot;
    }),
    max_installments: raw.transform((value, ctx) => {
      const n = value === "" ? 1 : Number(value);
      if (!Number.isInteger(n) || n < 1 || n > PAYMENT_LINK_INSTALLMENTS_MAX) {
        ctx.addIssue({ code: "custom", message: `מספר התשלומים בין 1 ל-${PAYMENT_LINK_INSTALLMENTS_MAX}.` });
        return z.NEVER;
      }
      return n;
    }),
    expires_on: raw.refine((value) => isCalendarDate(value) && value >= today && value <= last, {
      message: `יש לבחור יום אחרון מהיום ועד ${PAYMENT_LINK_DAYS_MAX} יום קדימה.`,
    }),
  });
}

export const PAYMENT_LINK_FIELD_NAMES = ["amount", "max_installments", "expires_on"] as const;
