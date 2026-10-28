import type { BadgeTone } from "@/components/ui/badge";
import type { DocumentPaymentState } from "@/features/allocations/state";

// DOC-03: a document's payment state on the list, from PAY-02's state (public.money_allocation_state) and the due date.
// Mirrors app.document_pay_state (migration documents_pay_state; test 270 compares the two). Pure, unit tested.

export const DOCUMENT_PAY_STATES = ["open", "partial", "paid", "overdue", "cancelled", "transferred", "none"] as const;
export type DocumentPayState = (typeof DOCUMENT_PAY_STATES)[number];

/** The spec's five (DOC-03): the list's filter choices. */
export const DOCUMENT_PAY_FILTERS = ["open", "partial", "paid", "overdue", "cancelled"] as const satisfies readonly DocumentPayState[];
export type DocumentPayFilter = (typeof DOCUMENT_PAY_FILTERS)[number];
export const isDocumentPayFilter = (value: unknown): value is DocumentPayFilter =>
  typeof value === "string" && (DOCUMENT_PAY_FILTERS as readonly string[]).includes(value);

export const DOCUMENT_PAY_STATE_LABELS: Record<DocumentPayState, string> = {
  open: "פתוח",
  partial: "שולם חלקית",
  paid: "שולם",
  overdue: "באיחור",
  cancelled: "בוטל",
  transferred: "הועבר לחשבונית",
  none: "ללא יתרה",
};

export const DOCUMENT_PAY_STATE_TONES: Record<DocumentPayState, BadgeTone> = {
  open: "accent",
  partial: "warning",
  paid: "success",
  overdue: "danger",
  cancelled: "warning",
  transferred: "neutral",
  none: "neutral",
};

/** cancelled > paid > overdue (a balance past its due date) > partial > open; a proforma billed by an invoice is transferred. */
export function documentPayState(cancelled: boolean, state: DocumentPaymentState | null, dueDate: string | null, today: string): DocumentPayState {
  if (cancelled) return "cancelled";
  if (state === "paid" || state === "paid_on_issue") return "paid";
  if ((state === "unpaid" || state === "partial") && dueDate !== null && dueDate < today) return "overdue";
  if (state === "partial") return "partial";
  if (state === "unpaid") return "open";
  if (state === "transferred") return "transferred";
  return "none";
}
