import type { Metadata } from "next";
import Link from "next/link";

import { Card, CardBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page-header";
import { bankLabel, CHEQUE_STATUS_LABELS, next30DaysTotal } from "@/features/payments/cheques";
import { paymentHome } from "@/features/payments/components/payments-table";
import { paymentsPath } from "@/features/payments/paths";
import { DEFERRED_CHEQUES_LIMIT, getPaymentsAccess, listDeferredCheques } from "@/features/payments/queries";
import { getOrgContext } from "@/features/shell/queries";
import { formatDate, formatMoney, zoneDate } from "@/lib/format";

export const metadata: Metadata = { title: "צ'קים דחויים" };

type Props = { params: Promise<{ orgId: string }> };

/**
 * PAY-04 answer 7 (owner, 21 October 2026): the cheques not cashed yet (in hand or deposited), by due date, with the total of
 * the next 30 days. Read with the user's session (the payments RLS decides). A cheque's status moves on its payment's card.
 */
export default async function DeferredChequesPage({ params }: Props) {
  const { orgId } = await params;
  const [context, access] = await Promise.all([getOrgContext(orgId), getPaymentsAccess(orgId)]);
  const back = { href: paymentsPath(orgId), label: "לכל התשלומים" };
  if (!access.inPlan) {
    return (
      <>
        <PageHeader title="צ'קים דחויים" back={back} />
        <Card>
          <CardBody>
            <p>רישום תשלומים לא כלול בחבילה של העסק.</p>
          </CardBody>
        </Card>
      </>
    );
  }
  const today = zoneDate(new Date(), context.org.timeZone);
  const { cheques, complete } = await listDeferredCheques(orgId);
  const soon = next30DaysTotal(cheques, today);
  const day = (value: string) => formatDate(`${value}T12:00:00Z`);
  return (
    <>
      <PageHeader title="צ'קים דחויים" description="צ'קים שעוד לא נפרעו (ביד או שהופקדו), לפי תאריך הפירעון. את מצב הצ'ק מעדכנים בכרטיס התשלום." back={back} />
      <Card className="mb-4">
        <CardBody>
          <p className="text-md">
            לפירעון ב-30 הימים הקרובים: <span className="font-medium tabular-nums">{formatMoney(soon)}</span>
          </p>
          {!complete ? <p className="text-sm text-ink-soft">מוצגים {DEFERRED_CHEQUES_LIMIT.toLocaleString("he-IL")} הצ&apos;קים הראשונים; הסכום כולל רק אותם.</p> : null}
        </CardBody>
      </Card>
      {cheques.length === 0 ? (
        <EmptyState title="אין צ'קים דחויים" description="צ'ק שנרשם במצב ביד או הופקד יופיע כאן עד שייפרע." />
      ) : (
        <Card>
          <CardBody className="p-0">
            <ul className="divide-y divide-line">
              {cheques.map((cheque) => {
                const home = paymentHome(orgId, cheque);
                const late = cheque.dueDate < today;
                return (
                  <li key={cheque.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium break-words">
                        {home ? (
                          <Link href={home} className="text-accent-strong underline-offset-4 hover:underline">
                            {cheque.customer ? <bdi>{cheque.customer}</bdi> : "לקוח"}
                          </Link>
                        ) : cheque.customer ? (
                          <bdi>{cheque.customer}</bdi>
                        ) : (
                          "לקוח שנמחק"
                        )}
                      </p>
                      <p className="text-sm text-ink-soft">
                        {"צ'ק "}
                        {cheque.number ? <bdi dir="ltr">{cheque.number}</bdi> : null}
                        {cheque.bank ? ` · ${bankLabel(cheque.bank, cheque.bankName)}` : ""}
                        {cheque.branch ? ` · סניף ${cheque.branch}` : ""}
                        {` · ${CHEQUE_STATUS_LABELS[cheque.status]}`}
                      </p>
                    </div>
                    <span className="text-end">
                      <span className="block font-medium tabular-nums">{formatMoney(cheque.amountAgorot)}</span>
                      <span className={`block text-sm ${late ? "text-danger" : "text-ink-soft"}`}>
                        {late ? "היה לפירעון ב-" : "לפירעון ב-"}
                        {day(cheque.dueDate)}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>
      )}
    </>
  );
}
