import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page-header";
import { paymentsPath } from "@/features/payments/paths";
import { recurringBillingPath } from "@/features/recurring-billing/paths";
import { getRecurringAccess, listBillings } from "@/features/recurring-billing/queries";
import { BILLING_STATUS_LABELS, BILLING_STATUS_TONE } from "@/features/recurring-billing/schema";
import { monthlyAmount } from "@/features/recurring-billing/schedule";
import { billingAmountText, billingsEmptyText, nextCycleText } from "@/features/recurring-billing/texts";
import { getOrgTerms } from "@/features/terminology/queries";
import { formatMoney } from "@/lib/format";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "חיובים חוזרים" };

type Props = { params: Promise<{ orgId: string }> };

/**
 * SUB-01..SUB-04: the recurring billings of the business's customers the user reads (RLS: whoever reads the customer),
 * newest first. A billing is made on a contact's or company's card, or from a won deal; it is worked on its own page.
 */
export default async function RecurringBillingsPage({ params }: Props) {
  const { orgId } = await params;
  const access = await getRecurringAccess(orgId);
  const back = { href: paymentsPath(orgId), label: "לכל התשלומים" };
  const [billings, terms] = await Promise.all([listBillings(orgId), getOrgTerms(orgId)]);
  if (!access.inPlan && billings.length === 0) {
    return (
      <>
        <PageHeader title="חיובים חוזרים" back={back} />
        <Card>
          <CardBody>
            <p>חיובים חוזרים ללקוחות כלולים בחבילה המקצועית ומעלה.</p>
          </CardBody>
        </Card>
      </>
    );
  }
  const live = billings.filter((b) => b.status === "active" && (b.endDate === null || b.nextCycleOn !== null));
  const mrr = live.reduce((sum, b) => sum + monthlyAmount(b.amountAgorot, b.cycle), 0);
  return (
    <>
      <PageHeader
        title="חיובים חוזרים"
        description="ריטיינרים ומנויים של לקוחות. בכל מחזור נוצרת משימה לנציג להפיק מסמך ולרשום אותו. חיוב חדש יוצרים בכרטיס איש הקשר או החברה, או מעסקה שנסגרה."
        back={back}
      />
      <Card className="mb-4">
        <CardBody>
          <p className="text-md">
            הכנסה חודשית חוזרת מחיובים פעילים: <span className="font-medium tabular-nums">{formatMoney(mrr)}</span> לפני מע&quot;מ
          </p>
          <p className="text-sm text-ink-soft">{live.length.toLocaleString("he-IL")} חיובים פעילים</p>
        </CardBody>
      </Card>
      {billings.length === 0 ? (
        <EmptyState title="אין עדיין חיובים חוזרים" description={billingsEmptyText(terms)} />
      ) : (
        <Card>
          <CardBody className="p-0">
            <ul className="divide-y divide-line">
              {billings.map((billing) => (
                <li key={billing.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-4 py-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="font-medium break-words">
                      <Link href={recurringBillingPath(orgId, billing.id)} className="text-accent-strong underline-offset-4 hover:underline">
                        {billing.name}
                      </Link>
                    </p>
                    <p className="text-sm text-ink-soft">
                      <Link
                        href={billing.contactId ? paths.contact(orgId, billing.contactId) : paths.company(orgId, billing.companyId ?? "")}
                        className="underline-offset-4 hover:underline"
                      >
                        <bdi>{billing.customerName || "לקוח"}</bdi>
                      </Link>
                      {" · "}
                      {billingAmountText(billing.amountAgorot, billing.cycle)}
                    </p>
                    <p className="text-sm text-ink-soft">{nextCycleText(billing.status, billing.nextCycleOn, billing.endDate)}</p>
                  </div>
                  <Badge tone={BILLING_STATUS_TONE[billing.status]}>{BILLING_STATUS_LABELS[billing.status]}</Badge>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </>
  );
}
