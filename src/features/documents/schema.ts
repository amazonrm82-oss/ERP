import { z } from "zod";

import { isCalendarDate } from "@/lib/calendar-date";
import { parseMoneyToAgorot } from "@/lib/format";

// DOC-01 (owner, 20 October 2026): an accounting document issued outside the system, recorded on a deal or a contact.
// Mirrors the checks of public.accounting_documents (migration accounting_documents).

export const DOCUMENT_TYPES = ["tax_invoice", "tax_invoice_receipt", "receipt", "credit_invoice", "proforma"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  tax_invoice: "חשבונית מס",
  tax_invoice_receipt: "חשבונית מס/קבלה",
  receipt: "קבלה",
  credit_invoice: "חשבונית זיכוי",
  proforma: "חשבונית עסקה",
};

export function isDocumentType(value: unknown): value is DocumentType {
  return typeof value === "string" && (DOCUMENT_TYPES as readonly string[]).includes(value);
}

export const DOCUMENT_NUMBER_MAX = 40;
export const CANCEL_REASON_MAX = 500;
// accounting_documents.amount_agorot
export const DOCUMENT_AMOUNT_MAX = 1_000_000_000_000;

export const DOCUMENT_FIELD_NAMES = ["doc_type", "number", "doc_date", "amount"] as const;

const raw = z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string());

export const documentSchema = z.object({
  doc_type: raw.refine(isDocumentType, "יש לבחור סוג מסמך.").transform((value) => value as DocumentType),
  number: raw.pipe(
    z
      .string()
      .min(1, { error: "יש להזין את מספר המסמך." })
      .max(DOCUMENT_NUMBER_MAX, { error: `מספר המסמך עד ${DOCUMENT_NUMBER_MAX} תווים.` }),
  ),
  doc_date: raw.refine((value) => isCalendarDate(value), "יש לבחור את תאריך המסמך."),
  amount: raw.transform((value, ctx) => {
    const agorot = value === "" ? null : parseMoneyToAgorot(value);
    if (agorot === null || agorot > DOCUMENT_AMOUNT_MAX) {
      ctx.addIssue({ code: "custom", message: "יש להזין את סכום המסמך בשקלים, למשל 1,170." });
      return z.NEVER;
    }
    return agorot;
  }),
});

export const cancelReasonSchema = z
  .string()
  .trim()
  .min(1, { error: "יש לכתוב למה הרישום מבוטל." })
  .max(CANCEL_REASON_MAX, { error: `עד ${CANCEL_REASON_MAX} תווים.` });
