import { ALLOCATION_FAILURE_CODES, isAllocationFailureCode, type AllocationFailureCode } from "@/features/invoicing/providers/types";

// DOC-10: the allocation number on a document, and the mark when the invoice provider did not get one. The codes are the
// closed list of the provider contract (= app.allocation_failure_codes()); the database stores only them, on
// accounting_documents.allocation_failed_at / allocation_error_code (server only). Whether a number was needed is the
// provider's call: nothing here works out the threshold.

export { ALLOCATION_FAILURE_CODES };

export const ALLOCATION_FAILURE_LABELS: Record<AllocationFailureCode, string> = {
  tax_authority_refused: "רשות המסים סירבה לבקשה",
  tax_authority_unavailable: "השירות של רשות המסים לא היה זמין",
  customer_tax_id: "חסר מספר עוסק או ח.פ. תקין של הלקוח",
  business_not_authorized: "העסק לא מחובר לרשות המסים אצל ספק החשבוניות",
  invalid_number: "הספק החזיר מספר הקצאה לא תקין",
  other: "סיבה אחרת אצל ספק החשבוניות",
};

/** A stored code as its reason; a code this version does not know reads as "other" (never shown raw). */
export function allocationFailureReason(code: string | null): string | null {
  if (code === null) return null;
  return ALLOCATION_FAILURE_LABELS[isAllocationFailureCode(code) ? code : "other"];
}

/** The mark on a document whose provider did not get an allocation number; null when it is not marked. */
export function allocationFailureText(doc: { allocationNumber: string | null; allocationErrorCode: string | null }): string | null {
  if (doc.allocationNumber || doc.allocationErrorCode === null) return null;
  return `לא התקבל מספר הקצאה: ${allocationFailureReason(doc.allocationErrorCode)}`;
}
