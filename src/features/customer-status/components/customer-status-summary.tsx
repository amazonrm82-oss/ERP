import { Badge } from "@/components/ui/badge";
import { formatDate, formatMoney } from "@/lib/format";

import { getCustomerSummary } from "../queries";
import { CUSTOMER_STATUS_LABELS, CUSTOMER_STATUS_TONES, statusExplanation, valueDetail } from "../status";

type Props = { orgId: string; where: { contact: string | null; company: string | null } };

/**
 * CON-11: the customer's status (by its last won deal) and its cumulative value, at the top of the contact and company
 * pages. Nothing for a record with no won deal; only a note when some of its won deals are hidden from the user.
 */
export async function CustomerStatusSummary({ orgId, where }: Props) {
  const summary = await getCustomerSummary(orgId, where.contact, where.company);
  if (!summary.allowed) return null;
  if (summary.partial) {
    return (
      <p className="mb-4 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink-soft" role="note">
        סטטוס לקוח: חלק מהעסקאות של הלקוח לא גלויות לך, ולכן אין סטטוס וערך.
      </p>
    );
  }
  if (!summary.customer) return null;
  return (
    <section aria-label="סטטוס הלקוח" className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-line bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={CUSTOMER_STATUS_TONES[summary.status]}>{CUSTOMER_STATUS_LABELS[summary.status]}</Badge>
        <span className="text-sm text-ink-soft">{statusExplanation(summary, formatDate)}</span>
      </div>
      <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
        <div className="flex items-baseline gap-2">
          <dt className="text-ink-soft">קנייה אחרונה</dt>
          <dd className="font-semibold">{formatDate(summary.last_purchase_on)}</dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="text-ink-soft">ערך מצטבר</dt>
          <dd className="font-semibold tabular-nums">{formatMoney(summary.value_agorot)}</dd>
          <dd className="text-ink-soft">({valueDetail(summary)})</dd>
        </div>
      </dl>
    </section>
  );
}
