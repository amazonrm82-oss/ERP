import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { BulkSelection, RowCheck } from "@/features/bulk/components/bulk-selection";
import { ListTable } from "@/features/list-columns/components/list-table";
import type { CatalogColumn, ColumnChoice } from "@/features/list-columns/columns";
import { formatDate, formatMoney } from "@/lib/format";
import { paths } from "@/lib/paths";
import type { Sort } from "@/lib/sort";

import type { DocumentListItem } from "../queries";
import { DOCUMENT_TYPE_LABELS, documentTitle, isOpeningBalance } from "../schema";

type Props = {
  orgId: string;
  documents: DocumentListItem[];
  columns: ColumnChoice[];
  catalog: CatalogColumn[];
  recorderNames: Map<string, string>;
  sort: Sort<string>;
  sortHref: (key: string) => string;
  // the export route for "export the picked rows"; null when the user may not export
  exportPath: string | null;
};

/** Where a document is shown: the card of its deal, else of its contact, else (GAP-12) of its company; null when none is left. */
export function documentHome(orgId: string, doc: Pick<DocumentListItem, "dealId" | "contactId" | "companyId">): string | null {
  return doc.dealId
    ? paths.deal(orgId, doc.dealId)
    : doc.contactId
      ? paths.contact(orgId, doc.contactId)
      : doc.companyId
        ? paths.company(orgId, doc.companyId)
        : null;
}

/** A document's type and number, as the first column and the mobile list show them. */
export function DocumentName({ doc }: { doc: Pick<DocumentListItem, "docType" | "number" | "docDate"> }) {
  // GAP-12: an opening balance has no number; it is named by its date
  if (isOpeningBalance(doc.docType)) return <>{documentTitle(doc)}</>;
  return (
    <>
      {DOCUMENT_TYPE_LABELS[doc.docType]}{" "}
      <bdi dir="ltr" className="tabular-nums">
        {doc.number}
      </bdi>
    </>
  );
}

const day = (value: string) => (
  <time dateTime={value} className="whitespace-nowrap">
    {formatDate(value.length === 10 ? `${value}T12:00:00Z` : value)}
  </time>
);

/**
 * LST-09: the accounting documents as a table: the user's columns, sorting by any column, and "export the picked rows".
 * A document is recorded and cancelled only on its deal's or contact's card (owner, 21 October 2026), so there are no
 * other bulk actions and no editing in the cell; the name links to that card.
 */
export function DocumentsTable({ orgId, documents, columns, catalog, recorderNames, sort, sortHref, exportPath }: Props) {
  return (
    <BulkSelection
      orgId={orgId}
      object="document"
      ids={documents.map((doc) => doc.id)}
      owners={null}
      statuses={null}
      tags={[]}
      canTrash={false}
      exportPath={exportPath}
      enabled={exportPath !== null}
    >
      <ListTable
        label="מסמכים חשבונאיים"
        rows={documents}
        rowKey={(doc) => doc.id}
        nameColumn={{ key: "name", label: "מסמך" }}
        nameCell={(doc) => {
          const home = documentHome(orgId, doc);
          return (
            <div className="flex items-start gap-2">
              <RowCheck id={doc.id} label={documentTitle(doc)} />
              {home ? (
                <Link href={home} className="min-w-0 font-medium text-accent-strong underline-offset-4 hover:underline">
                  <DocumentName doc={doc} />
                </Link>
              ) : (
                <span className="min-w-0 font-medium">
                  <DocumentName doc={doc} />
                </span>
              )}
            </div>
          );
        }}
        columns={columns}
        catalog={catalog}
        fields={[]}
        customValues={() => ({})}
        sort={sort}
        sortHref={sortHref}
        cell={(key, doc) => {
          switch (key) {
            case "type":
              return DOCUMENT_TYPE_LABELS[doc.docType];
            case "customer":
              return doc.customer ? <bdi>{doc.customer}</bdi> : null;
            case "date":
              return day(doc.docDate);
            case "amount":
              return <span className={`whitespace-nowrap tabular-nums ${doc.cancelled ? "text-ink-soft line-through" : ""}`}>{formatMoney(doc.amountAgorot)}</span>;
            case "status":
              return doc.cancelled ? <Badge tone="warning">בוטל</Badge> : <Badge>בתוקף</Badge>;
            case "recorder":
              return doc.createdBy ? (recorderNames.get(doc.createdBy) ?? null) : null;
            case "created":
              return <span className="text-ink-soft">{day(doc.createdAt)}</span>;
            default:
              return null;
          }
        }}
      />
    </BulkSelection>
  );
}
