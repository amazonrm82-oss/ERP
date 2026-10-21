// LST-09: the payments list as a table for CSV / Excel (LST-08). Sums are plain numbers in shekels; dates are calendar days
// (the time of recording in the business's time zone). The note stays on the record's card.

import { plainShekels } from "@/features/products/export-table";
import { zoneDate } from "@/lib/format";

import type { PaymentListItem } from "./queries";
import { PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS } from "./schema";

export const PAYMENT_EXPORT_HEADER = ["סכום", "לקוח", "תאריך התשלום", "אמצעי תשלום", "מספר תשלומים", "אסמכתא", "מצב", "נרשם על ידי", "נרשם בתאריך"] as const;

type PaymentForExport = Pick<
  PaymentListItem,
  "amountAgorot" | "customer" | "paidOn" | "method" | "installments" | "reference" | "status" | "createdBy" | "createdAt"
>;

/** One row per payment, in the header's order; `recorderNames` maps a user id to the name shown in the list. */
export function paymentExportRows(payments: PaymentForExport[], recorderNames: Map<string, string>, timeZone: string): string[][] {
  return payments.map((payment) => [
    plainShekels(payment.amountAgorot),
    payment.customer ?? "",
    payment.paidOn,
    PAYMENT_METHOD_LABELS[payment.method],
    payment.installments ? String(payment.installments) : "",
    payment.reference ?? "",
    PAYMENT_STATUS_LABELS[payment.status],
    payment.createdBy ? (recorderNames.get(payment.createdBy) ?? "") : "",
    zoneDate(new Date(payment.createdAt), timeZone),
  ]);
}
