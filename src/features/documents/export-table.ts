// LST-09: the accounting documents list as a table for CSV / Excel (LST-08). Sums are plain numbers in shekels; dates are
// calendar days (the time of recording in the business's time zone).

import { plainShekels } from "@/features/products/export-table";
import { zoneDate } from "@/lib/format";

import { DOCUMENT_LIST_STATUS_LABELS } from "./list";
import type { DocumentListItem } from "./queries";
import { DOCUMENT_TYPE_LABELS } from "./schema";

export const DOCUMENT_EXPORT_HEADER = ["סוג", "מספר", "לקוח", "תאריך המסמך", "סכום", "מצב", "נרשם על ידי", "נרשם בתאריך"] as const;

type DocumentForExport = Pick<DocumentListItem, "docType" | "number" | "customer" | "docDate" | "amountAgorot" | "cancelled" | "createdBy" | "createdAt">;

/** One row per document, in the header's order; `recorderNames` maps a user id to the name shown in the list. */
export function documentExportRows(documents: DocumentForExport[], recorderNames: Map<string, string>, timeZone: string): string[][] {
  return documents.map((doc) => [
    DOCUMENT_TYPE_LABELS[doc.docType],
    doc.number,
    doc.customer ?? "",
    doc.docDate,
    plainShekels(doc.amountAgorot),
    DOCUMENT_LIST_STATUS_LABELS[doc.cancelled ? "cancelled" : "active"],
    doc.createdBy ? (recorderNames.get(doc.createdBy) ?? "") : "",
    zoneDate(new Date(doc.createdAt), timeZone),
  ]);
}
