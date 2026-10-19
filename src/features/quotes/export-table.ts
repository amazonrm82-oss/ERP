// LST-09: the quotes list as a table for CSV / Excel (LST-08). Sums are plain numbers in shekels; dates are calendar days in
// the business's time zone. A draft has no number yet (QUO-03 gives it one when it is sent).

import { plainShekels } from "@/features/products/export-table";
import { zoneDate } from "@/lib/format";

import type { QuoteListItem } from "./queries";
import { QUOTE_STATUS_LABELS } from "./schema";

export const QUOTE_EXPORT_HEADER = ["מספר", "כותרת", "מצב", "לקוח", "אחראי", "תאריך ההצעה", "בתוקף עד", "נשלחה", 'סכום כולל מע"מ', "נוצרה"] as const;

type QuoteForExport = Pick<
  QuoteListItem,
  "numberDisplay" | "title" | "status" | "customer" | "ownerId" | "quoteDate" | "validUntil" | "sentAt" | "totalAgorot" | "createdAt"
>;

/** One row per quote, in the header's order; `ownerNames` maps a user id to the name shown in the list. */
export function quoteExportRows(quotes: QuoteForExport[], ownerNames: Map<string, string>, timeZone: string): string[][] {
  return quotes.map((quote) => [
    quote.numberDisplay ?? "",
    quote.title,
    QUOTE_STATUS_LABELS[quote.status],
    quote.customer ?? "",
    quote.ownerId ? (ownerNames.get(quote.ownerId) ?? "") : "",
    quote.quoteDate,
    quote.validUntil ?? "",
    quote.sentAt ? zoneDate(new Date(quote.sentAt), timeZone) : "",
    plainShekels(quote.totalAgorot),
    zoneDate(new Date(quote.createdAt), timeZone),
  ]);
}
