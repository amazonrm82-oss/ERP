import { z } from "zod";

import { isCalendarDate } from "@/lib/calendar-date";
import { formatDate, parseMoneyToAgorot } from "@/lib/format";

// DOC-01 (owner, 20 October 2026): an accounting document issued outside the system, recorded on a deal or a contact.
// Mirrors the checks of public.accounting_documents (migration accounting_documents).

// GAP-12 (owner, 26 October 2026): `opening_balance` is an imported customer's opening balance: no running number, a signed
// amount (negative = a credit), owners and admins only.
export const DOCUMENT_TYPES = ["tax_invoice", "tax_invoice_receipt", "receipt", "credit_invoice", "proforma", "opening_balance"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  tax_invoice: "חשבונית מס",
  tax_invoice_receipt: "חשבונית מס/קבלה",
  receipt: "קבלה",
  credit_invoice: "חשבונית זיכוי",
  proforma: "חשבונית עסקה",
  opening_balance: "יתרת פתיחה",
};

export const OPENING_BALANCE = "opening_balance" satisfies DocumentType;
export const isOpeningBalance = (type: DocumentType) => type === OPENING_BALANCE;
/** The types a person picks in the recording form: an opening balance only for owners and admins. */
export const recordableTypes = (canOpening: boolean): readonly DocumentType[] => DOCUMENT_TYPES.filter((type) => canOpening || !isOpeningBalance(type));

/**
 * How a document is named on every screen: its type and number ("חשבונית מס 1001"); an opening balance has no number and
 * is named by its date ("יתרת פתיחה מתאריך 1 בינו׳ 2026", GAP-12).
 */
export function documentTitle(doc: { docType: DocumentType; number: string | null; docDate: string }): string {
  if (isOpeningBalance(doc.docType)) return `${DOCUMENT_TYPE_LABELS[doc.docType]} מתאריך ${formatDate(`${doc.docDate}T12:00:00Z`)}`;
  return `${DOCUMENT_TYPE_LABELS[doc.docType]} ${doc.number ?? ""}`.trim();
}

export function isDocumentType(value: unknown): value is DocumentType {
  return typeof value === "string" && (DOCUMENT_TYPES as readonly string[]).includes(value);
}

export const DOCUMENT_NUMBER_MAX = 40;
export const CANCEL_REASON_MAX = 500;
// accounting_documents.amount_agorot
export const DOCUMENT_AMOUNT_MAX = 1_000_000_000_000;

export const DOCUMENT_FIELD_NAMES = ["doc_type", "number", "doc_date", "amount", "due_date"] as const;

// PAY-02 answer 7: the types that carry a balance, and so a due date; GAP-12: and an opening balance that is a debt (positive)
export const DUE_DATE_TYPES: readonly DocumentType[] = ["tax_invoice", "proforma"];
export const takesDueDate = (type: DocumentType, amountAgorot?: number) =>
  DUE_DATE_TYPES.includes(type) || (isOpeningBalance(type) && (amountAgorot === undefined || amountAgorot > 0));

const raw = z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string());

/** "-1,250.50" -> -125050 (GAP-12: an opening balance may be negative, a credit). Null when it is not an amount. */
export function parseSignedAgorot(input: string): number | null {
  const trimmed = input.trim().replace(/^[\u2212\u2013]/, "-");
  const negative = trimmed.startsWith("-");
  const agorot = parseMoneyToAgorot(negative ? trimmed.slice(1) : trimmed);
  return agorot === null ? null : negative ? -agorot : agorot;
}

export const documentSchema = z.object({
  doc_type: raw.refine(isDocumentType, "יש לבחור סוג מסמך.").transform((value) => value as DocumentType),
  // GAP-12: an opening balance has no number (whatever arrives is dropped below)
  number: raw.pipe(z.string().max(DOCUMENT_NUMBER_MAX, { error: `מספר המסמך עד ${DOCUMENT_NUMBER_MAX} תווים.` })),
  doc_date: raw.refine((value) => isCalendarDate(value), "יש לבחור את תאריך המסמך."),
  // signed here; only an opening balance may be negative (checked below)
  amount: raw.transform((value, ctx) => {
    const agorot = value === "" ? null : parseSignedAgorot(value);
    if (agorot === null || Math.abs(agorot) > DOCUMENT_AMOUNT_MAX) {
      ctx.addIssue({ code: "custom", message: "יש להזין את סכום המסמך בשקלים, למשל 1,170." });
      return z.NEVER;
    }
    return agorot;
  }),
  // PAY-02 answer 7: empty = from the customer's payment terms (the database fills it)
  due_date: raw.refine((value) => value === "" || isCalendarDate(value), "יש לבחור תאריך, או להשאיר ריק.").transform((value) => value || null),
}).superRefine((value, ctx) => {
  const opening = isOpeningBalance(value.doc_type);
  if (!opening && value.number === "") {
    ctx.addIssue({ code: "custom", path: ["number"], message: "יש להזין את מספר המסמך." });
  }
  if (opening && value.amount === 0) {
    ctx.addIssue({ code: "custom", path: ["amount"], message: "יתרת פתיחה היא חוב (סכום חיובי) או זכות (סכום שלילי), לא 0." });
  } else if (!opening && value.amount < 0) {
    ctx.addIssue({ code: "custom", path: ["amount"], message: "סכום שלילי נרשם רק ביתרת פתיחה." });
  }
  if (value.due_date && !takesDueDate(value.doc_type, value.amount)) {
    ctx.addIssue({
      code: "custom",
      path: ["due_date"],
      message: opening ? "מועד תשלום נקבע רק ביתרת פתיחה שהיא חוב (סכום חיובי)." : "מועד תשלום נקבע רק בחשבונית מס או בחשבון עסקה.",
    });
  } else if (value.due_date && value.due_date < value.doc_date) {
    ctx.addIssue({ code: "custom", path: ["due_date"], message: "מועד התשלום לא לפני תאריך המסמך." });
  }
}).transform((value) => ({ ...value, number: isOpeningBalance(value.doc_type) ? null : value.number }));

/** A due date typed on the card: a calendar day, or empty to clear it. */
export const dueDateSchema = z.string().trim().refine((value) => value === "" || isCalendarDate(value), "יש לבחור תאריך, או להשאיר ריק.");

export const cancelReasonSchema = z
  .string()
  .trim()
  .min(1, { error: "יש לכתוב למה הרישום מבוטל." })
  .max(CANCEL_REASON_MAX, { error: `עד ${CANCEL_REASON_MAX} תווים.` });
