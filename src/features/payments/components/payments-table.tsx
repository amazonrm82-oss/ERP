import Link from "next/link";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { BulkSelection, RowCheck } from "@/features/bulk/components/bulk-selection";
import { ListTable } from "@/features/list-columns/components/list-table";
import type { CatalogColumn, ColumnChoice } from "@/features/list-columns/columns";
import { formatDate, formatMoney } from "@/lib/format";
import { paths } from "@/lib/paths";
import type { Sort } from "@/lib/sort";

import type { PaymentListItem } from "../queries";
import { PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS, type PaymentStatus } from "../schema";

type Props = {
  orgId: string;
  payments: PaymentListItem[];
  columns: ColumnChoice[];
  catalog: CatalogColumn[];
  recorderNames: Map<string, string>;
  sort: Sort<string>;
  sortHref: (key: string) => string;
  // the export route for "export the picked rows"; null when the user may not export
  exportPath: string | null;
};

export const PAYMENT_STATUS_TONES: Record<PaymentStatus, BadgeTone> = {
  recorded: "neutral",
  confirmed: "success",
  failed: "danger",
  refunded: "warning",
  cancelled: "warning",
};

/** Whether a payment counts as received (recorded or confirmed); the others are shown struck through. */
export const paymentCounts = (status: PaymentStatus) => status === "recorded" || status === "confirmed";

/** Where a payment is shown: the card of its deal, else of its contact; null when both were deleted. */
export function paymentHome(orgId: string, payment: Pick<PaymentListItem, "dealId" | "contactId">): string | null {
  return payment.dealId ? paths.deal(orgId, payment.dealId) : payment.contactId ? paths.contact(orgId, payment.contactId) : null;
}

const day = (value: string) => (
  <time dateTime={value} className="whitespace-nowrap">
    {formatDate(value.length === 10 ? `${value}T12:00:00Z` : value)}
  </time>
);

/**
 * LST-09: the payments as a table: the user's columns, sorting by any column, and "export the picked rows". A payment is
 * recorded, moved and corrected only on its deal's or contact's card (owner, 21 October 2026), so there are no other bulk
 * actions and no editing in the cell; the amount links to that card.
 */
export function PaymentsTable({ orgId, payments, columns, catalog, recorderNames, sort, sortHref, exportPath }: Props) {
  return (
    <BulkSelection
      orgId={orgId}
      object="payment"
      ids={payments.map((payment) => payment.id)}
      owners={null}
      statuses={null}
      tags={[]}
      canTrash={false}
      exportPath={exportPath}
      enabled={exportPath !== null}
    >
      <ListTable
        label="תשלומים"
        rows={payments}
        rowKey={(payment) => payment.id}
        nameColumn={{ key: "name", label: "סכום" }}
        nameCell={(payment) => {
          const home = paymentHome(orgId, payment);
          const amount = <span className={`tabular-nums ${paymentCounts(payment.status) ? "" : "text-ink-soft line-through"}`}>{formatMoney(payment.amountAgorot)}</span>;
          return (
            <div className="flex items-start gap-2">
              <RowCheck id={payment.id} label={`${formatMoney(payment.amountAgorot)} מ-${formatDate(`${payment.paidOn}T12:00:00Z`)}`} />
              {home ? (
                <Link href={home} className="min-w-0 font-medium whitespace-nowrap text-accent-strong underline-offset-4 hover:underline">
                  {amount}
                </Link>
              ) : (
                <span className="min-w-0 font-medium whitespace-nowrap">{amount}</span>
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
        cell={(key, payment) => {
          switch (key) {
            case "customer":
              return payment.customer ? <bdi>{payment.customer}</bdi> : null;
            case "date":
              return day(payment.paidOn);
            case "method":
              return PAYMENT_METHOD_LABELS[payment.method];
            case "installments":
              return payment.installments ? <span className="tabular-nums">{payment.installments}</span> : null;
            case "reference":
              return payment.reference ? <bdi dir="ltr">{payment.reference}</bdi> : null;
            case "status":
              return <Badge tone={PAYMENT_STATUS_TONES[payment.status]}>{PAYMENT_STATUS_LABELS[payment.status]}</Badge>;
            case "recorder":
              return payment.createdBy ? (recorderNames.get(payment.createdBy) ?? null) : null;
            case "created":
              return <span className="text-ink-soft">{day(payment.createdAt)}</span>;
            default:
              return null;
          }
        }}
      />
    </BulkSelection>
  );
}
