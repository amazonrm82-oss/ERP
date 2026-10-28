import { cn } from "@/lib/cn";
import { formatMoney } from "@/lib/format";

import { overdueDetail } from "../debt";
import { LEDGER_PARTIAL_TEXT } from "../ledger";
import { getDebtSummary, ledgerInPlan } from "../queries";

type Props = { orgId: string; where: { contact: string | null; company: string | null } };

/**
 * BAL-02: the customer's open debt and overdue debt at the top of the contact and company pages. The same people who
 * open the ledger (BAL-01) see it; when some of the customer's rows are hidden from them it shows no figure, only that
 * the view is partial. A contact with a company shows the company's debt (PAY-02's customer). Links to the ledger.
 */
export async function DebtSummary({ orgId, where }: Props) {
  if (!(await ledgerInPlan(orgId))) return null;
  const summary = await getDebtSummary(orgId, where.contact, where.company);
  if (!summary.allowed) return null;
  if (summary.partial) {
    return (
      <p className="mb-4 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink-soft" role="note">
        יתרת חוב: {LEDGER_PARTIAL_TEXT}, ולכן אין סכום.
      </p>
    );
  }
  const detail = overdueDetail(summary);
  const late = summary.overdue_debt > 0;
  return (
    <section aria-label="חוב הלקוח" className="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2">
      <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
        <div className="flex items-baseline gap-2">
          <dt className="text-ink-soft">יתרת חוב פתוחה</dt>
          <dd className="font-semibold tabular-nums">{formatMoney(summary.open_debt)}</dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="text-ink-soft">חוב באיחור</dt>
          <dd className={cn("font-semibold tabular-nums", late && "text-danger")}>{formatMoney(summary.overdue_debt)}</dd>
          {detail ? <dd className="text-ink-soft">({detail})</dd> : null}
        </div>
      </dl>
      <a href="#ledger" className="mt-1 inline-block text-sm text-accent underline-offset-2 hover:underline print:hidden">
        לכרטסת
      </a>
    </section>
  );
}
