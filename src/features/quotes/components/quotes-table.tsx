import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { BulkSelection, RowCheck } from "@/features/bulk/components/bulk-selection";
import { ListTable } from "@/features/list-columns/components/list-table";
import type { CatalogColumn, ColumnChoice } from "@/features/list-columns/columns";
import { formatDate, formatMoney } from "@/lib/format";
import type { Sort } from "@/lib/sort";

import { quotePath } from "../paths";
import type { QuoteListItem } from "../queries";
import { QUOTE_STATUS_LABELS } from "../schema";

type Props = {
  orgId: string;
  quotes: QuoteListItem[];
  columns: ColumnChoice[];
  catalog: CatalogColumn[];
  ownerNames: Map<string, string>;
  sort: Sort<string>;
  sortHref: (key: string) => string;
  // the export route for "export the picked rows"; null when the user may not export
  exportPath: string | null;
};

/** A quote's number (once sent) and title, as the first column and the mobile list show them. */
export function QuoteName({ quote }: { quote: Pick<QuoteListItem, "numberDisplay" | "title"> }) {
  return (
    <>
      {quote.numberDisplay ? (
        <span dir="ltr" className="tabular-nums">
          {quote.numberDisplay}
        </span>
      ) : null}
      {quote.numberDisplay ? " · " : null}
      <bdi>{quote.title}</bdi>
    </>
  );
}

const day = (value: string | null) =>
  value ? (
    <time dateTime={value} className="whitespace-nowrap">
      {formatDate(value)}
    </time>
  ) : null;

/**
 * LST-09: the quotes list as a table: the user's columns, sorting by any column, and "export the picked rows". A quote
 * changes only on its own screen (sending, versions, cancelling), so there are no other bulk actions and no editing in
 * the cell.
 */
export function QuotesTable({ orgId, quotes, columns, catalog, ownerNames, sort, sortHref, exportPath }: Props) {
  return (
    <BulkSelection
      orgId={orgId}
      object="quote"
      ids={quotes.map((quote) => quote.id)}
      owners={null}
      statuses={null}
      tags={[]}
      canTrash={false}
      exportPath={exportPath}
      enabled={exportPath !== null}
    >
      <ListTable
        label="הצעות מחיר"
        rows={quotes}
        rowKey={(quote) => quote.id}
        nameColumn={{ key: "name", label: "הצעה" }}
        nameCell={(quote) => (
          <div className="flex items-start gap-2">
            <RowCheck id={quote.id} label={quote.numberDisplay ? `${quote.numberDisplay} ${quote.title}` : quote.title} />
            <Link href={quotePath(orgId, quote.id)} className="min-w-0 font-medium text-accent-strong underline-offset-4 hover:underline">
              <QuoteName quote={quote} />
            </Link>
          </div>
        )}
        columns={columns}
        catalog={catalog}
        fields={[]}
        customValues={() => ({})}
        sort={sort}
        sortHref={sortHref}
        cell={(key, quote) => {
          switch (key) {
            case "status":
              return <Badge>{QUOTE_STATUS_LABELS[quote.status]}</Badge>;
            case "customer":
              return quote.customer ? <bdi>{quote.customer}</bdi> : null;
            case "owner":
              return quote.ownerId ? (ownerNames.get(quote.ownerId) ?? null) : null;
            case "quote_date":
              return day(quote.quoteDate);
            case "valid_until":
              return day(quote.validUntil);
            case "sent":
              return day(quote.sentAt);
            case "total":
              return <span className="whitespace-nowrap tabular-nums">{formatMoney(quote.totalAgorot)}</span>;
            case "created":
              return <span className="text-ink-soft">{day(quote.createdAt)}</span>;
            default:
              return null;
          }
        }}
      />
    </BulkSelection>
  );
}
