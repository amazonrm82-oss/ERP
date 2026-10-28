import { z } from "zod";

import { parseMoneyToAgorot } from "@/lib/format";

import { DOCUMENT_AMOUNT_MAX, type DocumentType } from "./schema";

// DOC-02: the details a recorded document may carry beyond DOC-01 (migration document_details). Mirrors the constraints of
// public.accounting_documents (allocation_shape, vat_shape, source_shape) and the line trigger app.accounting_document_lines_check;
// the database stays the judge. Pure, unit tested (tests/unit/document-record-details.test.ts).

/** Spec 6.4: an allocation number belongs on a tax invoice or a tax invoice-receipt only. */
export const ALLOCATION_TYPES: readonly DocumentType[] = ["tax_invoice", "tax_invoice_receipt"];
export const takesAllocationNumber = (type: DocumentType) => ALLOCATION_TYPES.includes(type);
export const ALLOCATION_NUMBER_MAX = 20;
export const isAllocationNumber = (value: string) => new RegExp(`^[0-9]{1,${ALLOCATION_NUMBER_MAX}}$`).test(value);

/** Spec 6.4: a credit invoice refers to its original, a tax invoice or a tax invoice-receipt. */
export const ORIGINAL_TYPES: readonly DocumentType[] = ["tax_invoice", "tax_invoice_receipt"];

export const DOCUMENT_LINES_MAX = 200;
export const LINE_DESCRIPTION_MAX = 500;
export const LINE_QUANTITY_MAX = 1_000_000;

/** A line's total, as the database works it out: round(quantity x unit price) half up, less the line discount. */
export function documentLineTotal(line: { quantity: number; unitPriceAgorot: number; discountAgorot: number }): number {
  // quantities carry at most 3 decimals: work in thousandths (BigInt) so the half-up rounding is exact
  const thousandths = BigInt(Math.round(line.quantity * 1000)) * BigInt(line.unitPriceAgorot);
  return Number((thousandths + BigInt(500)) / BigInt(1000)) - line.discountAgorot;
}

export type DocumentLineInput = {
  description: string;
  quantity: number;
  unitPriceAgorot: number;
  discountAgorot: number;
  vatExempt: boolean;
};

/** One line as the form sends it (texts, as typed). */
export type DocumentLineDraft = { description: string; quantity: string; unitPrice: string; discount: string; vatExempt: boolean };
export const EMPTY_LINE: DocumentLineDraft = { description: "", quantity: "1", unitPrice: "", discount: "", vatExempt: false };

const lineDraftSchema = z.object({
  description: z.string(),
  quantity: z.string(),
  unitPrice: z.string(),
  discount: z.string(),
  vatExempt: z.boolean(),
});

/** The lines the form sends (JSON in the field `lines`): empty rows are left out; a row with an error names its number. */
export function parseDocumentLines(json: string): { ok: true; lines: DocumentLineInput[] } | { ok: false; message: string } {
  let raw: unknown;
  try {
    raw = json.trim() === "" ? [] : JSON.parse(json);
  } catch {
    return { ok: false, message: "השורות לא נקראו. נסו שוב." };
  }
  const parsed = z.array(lineDraftSchema).max(DOCUMENT_LINES_MAX + 50).safeParse(raw);
  if (!parsed.success) return { ok: false, message: "השורות לא נקראו. נסו שוב." };
  const lines: DocumentLineInput[] = [];
  for (const [index, draft] of parsed.data.entries()) {
    const description = draft.description.trim();
    if (description === "" && draft.unitPrice.trim() === "" && draft.discount.trim() === "") continue;
    const row = `שורה ${index + 1}: `;
    if (description === "") return { ok: false, message: `${row}יש לכתוב תיאור.` };
    if (description.length > LINE_DESCRIPTION_MAX) return { ok: false, message: `${row}התיאור עד ${LINE_DESCRIPTION_MAX} תווים.` };
    const quantity = Number(draft.quantity.trim().replace(/,/g, ""));
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > LINE_QUANTITY_MAX || Math.abs(Math.round(quantity * 1000) - quantity * 1000) > 1e-6) {
      return { ok: false, message: `${row}כמות חיובית, עד שלוש ספרות אחרי הנקודה.` };
    }
    const unitPriceAgorot = parseMoneyToAgorot(draft.unitPrice);
    const discountAgorot = parseMoneyToAgorot(draft.discount);
    if (unitPriceAgorot === null || unitPriceAgorot > DOCUMENT_AMOUNT_MAX) return { ok: false, message: `${row}יש להזין מחיר ליחידה בשקלים.` };
    if (discountAgorot === null || discountAgorot > DOCUMENT_AMOUNT_MAX) return { ok: false, message: `${row}יש להזין הנחה בשקלים, או להשאיר ריק.` };
    const line = { description, quantity, unitPriceAgorot, discountAgorot, vatExempt: draft.vatExempt };
    if (documentLineTotal(line) < 0) return { ok: false, message: `${row}ההנחה גדולה מסכום השורה.` };
    lines.push(line);
  }
  if (lines.length > DOCUMENT_LINES_MAX) return { ok: false, message: `במסמך יש עד ${DOCUMENT_LINES_MAX} שורות.` };
  return { ok: true, lines };
}

export type DocumentDetails = {
  allocationNumber: string | null;
  netAgorot: number | null;
  vatAgorot: number | null;
  vatRateBp: number | null;
  quoteId: string | null;
  originalDocumentId: string | null;
};

const optionalId = (value: string) => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : null);

/**
 * The optional details as typed: allocation number, the VAT split (before VAT + VAT = the document's amount), the VAT rate
 * in percent, the source quote and a credit invoice's original. Field errors by field name, like the record form's.
 */
export function parseDocumentDetails(
  values: { allocation_number: string; net: string; vat: string; vat_rate: string; quote_id: string; original_document_id: string },
  docType: DocumentType,
  amountAgorot: number,
): { ok: true; details: DocumentDetails } | { ok: false; fieldErrors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const allocation = values.allocation_number.trim();
  if (allocation !== "" && !takesAllocationNumber(docType)) errors.allocation_number = "מספר הקצאה נרשם רק בחשבונית מס או בחשבונית מס/קבלה.";
  else if (allocation !== "" && !isAllocationNumber(allocation)) errors.allocation_number = `מספר הקצאה הוא ספרות בלבד, עד ${ALLOCATION_NUMBER_MAX}.`;

  const netText = values.net.trim();
  const vatText = values.vat.trim();
  const rateText = values.vat_rate.trim();
  let netAgorot: number | null = null;
  let vatAgorot: number | null = null;
  let vatRateBp: number | null = null;
  if (netText !== "" || vatText !== "") {
    netAgorot = netText === "" ? null : parseMoneyToAgorot(netText);
    vatAgorot = vatText === "" ? null : parseMoneyToAgorot(vatText);
    if (netAgorot === null) errors.net = "יש להזין את הסכום לפני מע\"מ.";
    if (vatAgorot === null) errors.vat = "יש להזין את סכום המע\"מ (0 אם אין).";
    if (netAgorot !== null && vatAgorot !== null && netAgorot + vatAgorot !== amountAgorot) {
      errors.vat = "הסכום לפני מע\"מ ועוד המע\"מ צריכים להיות שווים לסכום המסמך.";
    }
  }
  if (rateText !== "") {
    const rate = Number(rateText.replace("%", ""));
    if (netText === "" && vatText === "") errors.vat_rate = "שיעור מע\"מ נרשם יחד עם הסכום לפני מע\"מ והמע\"מ.";
    else if (!Number.isFinite(rate) || rate < 0 || rate > 100 || Math.abs(Math.round(rate * 100) - rate * 100) > 1e-6) errors.vat_rate = "שיעור באחוזים, בין 0 ל-100.";
    else vatRateBp = Math.round(rate * 100);
  }
  const originalDocumentId = optionalId(values.original_document_id);
  if (originalDocumentId && docType !== "credit_invoice") errors.original_document_id = "מסמך מקורי נבחר רק בחשבונית זיכוי.";
  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };
  return {
    ok: true,
    details: {
      allocationNumber: allocation === "" ? null : allocation,
      netAgorot,
      vatAgorot,
      vatRateBp,
      quoteId: optionalId(values.quote_id),
      originalDocumentId,
    },
  };
}

/** Who issued a document: null = recorded by hand (DOC-01's mark). */
export function documentOrigin(provider: string | null): string {
  return provider ? `התקבל מספק החשבוניות (${provider})` : "נרשם ידנית";
}
