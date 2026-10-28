// LST-09: the accounting documents list as a table for CSV / Excel (LST-08). Sums are plain numbers in shekels; dates are
// calendar days (the time of recording in the business's time zone).

import { plainShekels } from "@/features/products/export-table";
import { zoneDate } from "@/lib/format";

import { DOCUMENT_LIST_STATUS_LABELS } from "./list";
import { DOCUMENT_PAY_STATE_LABELS, type DocumentPayState } from "./pay-state";
import type { DocumentListItem } from "./queries";
import { DOCUMENT_TYPE_LABELS } from "./schema";

export const DOCUMENT_EXPORT_HEADER = ["סוג", "מספר", "לקוח", "תאריך המסמך", "סכום", "מצב", "נרשם על ידי", "נרשם בתאריך"] as const;

type DocumentForExport = Pick<DocumentListItem, "docType" | "number" | "customer" | "docDate" | "amountAgorot" | "cancelled" | "createdBy" | "createdAt">;

/** One row per document, in the header's order; `recorderNames` maps a user id to the name shown in the list. */
export function documentExportRows(documents: DocumentForExport[], recorderNames: Map<string, string>, timeZone: string): string[][] {
  return documents.map((doc) => [
    DOCUMENT_TYPE_LABELS[doc.docType],
    // GAP-12: an opening balance has no number
    doc.number ?? "",
    doc.customer ?? "",
    doc.docDate,
    plainShekels(doc.amountAgorot),
    DOCUMENT_LIST_STATUS_LABELS[doc.cancelled ? "cancelled" : "active"],
    doc.createdBy ? (recorderNames.get(doc.createdBy) ?? "") : "",
    zoneDate(new Date(doc.createdAt), timeZone),
  ]);
}

/** DOC-03: the columns the export adds after the header: the due date always, the payment state and balance with the payments key. */
export function documentExtraHeader(payments: boolean): string[] {
  return payments ? ["מועד תשלום", "מצב תשלום", "יתרה"] : ["מועד תשלום"];
}

/** DOC-03: one document's extra cells, in documentExtraHeader's order (`pay` null = no payments key). */
export function documentExtraCells(doc: Pick<DocumentListItem, "dueDate">, pay: { payState: DocumentPayState; balance: number | null } | null | undefined, payments: boolean): string[] {
  const due = doc.dueDate ?? "";
  if (!payments) return [due];
  return [due, pay ? DOCUMENT_PAY_STATE_LABELS[pay.payState] : "", pay?.balance !== null && pay?.balance !== undefined ? plainShekels(pay.balance) : ""];
}
