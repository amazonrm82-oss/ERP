import { documentTitle } from "@/features/documents/schema";
import type { MoneySubject } from "@/features/payments/money-subject";
import { PAYMENT_METHOD_LABELS } from "@/features/payments/schema";
import { formatDate, formatMoney } from "@/lib/format";

import type { Allocation } from "../queries";
import { ChangeAllocationButton, UndoAllocationButton } from "./allocation-forms";

type Props = {
  orgId: string;
  page: MoneySubject;
  // the side the card shows: a payment lists its documents, a document its payments
  side: "payment" | "document";
  allocations: Allocation[];
  canChange: boolean;
};

/** PAY-02: the allocations of one payment or one document; owners and admins change or undo the counted ones. */
export function AllocationRows({ orgId, page, side, allocations, canChange }: Props) {
  if (allocations.length === 0) return null;
  return (
    <ul className="mt-1 space-y-1 text-sm">
      {allocations.map((a) => {
        const other =
          side === "payment"
            ? a.document
              ? documentTitle(a.document)
              : "מסמך"
            : a.payment
              ? `תשלום ${formatMoney(a.payment.amountAgorot)} ב${PAYMENT_METHOD_LABELS[a.payment.method]} מ-${formatDate(`${a.payment.paidOn}T12:00:00Z`)}`
              : "תשלום";
        const label = `${formatMoney(a.amountAgorot)} ${side === "payment" ? "ל" : "מ"}${other}`;
        return (
          <li key={a.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={a.counted ? "" : "text-ink-soft line-through"}>
              {side === "payment" ? "שויך ל" : "שויך מ"}
              <bdi>{other}</bdi>: <span className="tabular-nums">{formatMoney(a.amountAgorot)}</span>
            </span>
            {a.released ? <span className="text-ink-soft">(שוחרר כי התשלום או המסמך בוטלו)</span> : null}
            {!a.released && a.removedAt ? <span className="text-ink-soft">(השיוך בוטל ב-{formatDate(a.removedAt)})</span> : null}
            {canChange && a.counted ? (
              <span className="flex flex-wrap gap-1">
                <ChangeAllocationButton orgId={orgId} page={page} allocationId={a.id} amount={a.amountAgorot} label={label} />
                <UndoAllocationButton orgId={orgId} page={page} allocationId={a.id} label={label} />
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
