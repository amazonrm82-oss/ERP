import Link from "next/link";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { agorotInput } from "@/features/deals/recurring";
import { HolderFiles } from "@/features/files/components/holder-files";
import { listHolderFiles } from "@/features/files/holder-queries";
import { getOrgContext } from "@/features/shell/queries";
import { formatDate, formatMoney, zoneDate } from "@/lib/format";

import { paymentsPath } from "../paths";
import { getPaymentsAccess, listRecordPayments } from "../queries";
import { PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS, receivedTotal, type PaymentStatus } from "../schema";
import { CancelPaymentButton, CorrectPaymentButton, PaymentStatusSelect, RecordPaymentButton } from "./payment-forms";

type Props = {
  orgId: string;
  subject: { kind: "deal" | "contact"; id: string };
};

const STATUS_TONES: Record<PaymentStatus, BadgeTone> = {
  recorded: "neutral",
  confirmed: "success",
  failed: "danger",
  refunded: "warning",
  cancelled: "warning",
};

/**
 * PAY-01: the payments received and recorded on this deal or contact (amount, date, method, instalments, reference,
 * note, status). Owners, admins and managers record them and move their status, and whoever holds the personal key
 * `record_payments`; owners and admins also correct and cancel them (PAY-06; never deleted). Shown while the plan has `payments`.
 * Each payment may carry its file (a PDF or an image of the receipt or confirmation): the same people attach it, a new file
 * becomes the current one and the earlier ones stay as versions.
 */
export async function RecordPaymentsCard({ orgId, subject }: Props) {
  const access = await getPaymentsAccess(orgId);
  if (!access.inPlan) return null;
  const [{ payments, names }, context] = await Promise.all([listRecordPayments(orgId, subject), getOrgContext(orgId)]);
  if (payments.length === 0 && !access.canRecord) return null;
  // PAY-01 follow-up: each payment's file (a receipt, a confirmation), with its versions
  const { files, names: uploaders } = await listHolderFiles(
    orgId,
    "payment",
    payments.map((p) => p.id),
  );
  const today = zoneDate(new Date(), context.org.timeZone);
  const titleId = `payments-${subject.id}`;
  const total = receivedTotal(payments);
  return (
    <Card aria-labelledby={titleId} className="print:hidden">
      <CardHeader id={titleId} title="תשלומים" action={access.canRecord ? <RecordPaymentButton orgId={orgId} subject={subject} today={today} /> : null} />
      <CardBody className="p-0">
        {payments.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-soft">עוד לא נרשמו תשלומים. כאן רושמים כל תשלום שהתקבל: סכום, תאריך ואמצעי.</p>
        ) : (
          <>
            <p className="border-b border-line px-4 py-2 text-sm text-ink-soft">
              התקבלו <span className="font-medium text-ink tabular-nums">{formatMoney(total)}</span> (תשלומים במצב נרשם או אושר; לא נספרים תשלומים שבוטלו, נכשלו
              או הוחזרו)
            </p>
            <ul className="divide-y divide-line">
              {payments.map((payment) => {
                const label = `${formatMoney(payment.amountAgorot)} מ-${formatDate(`${payment.paidOn}T12:00:00Z`)}`;
                const recorder = payment.createdBy ? names.get(payment.createdBy) : undefined;
                const cancelled = payment.status === "cancelled";
                const muted = payment.status !== "recorded" && payment.status !== "confirmed";
                return (
                  <li key={payment.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium break-words">
                        <span className={`tabular-nums ${muted ? "text-ink-soft line-through" : ""}`}>{formatMoney(payment.amountAgorot)}</span>
                        {" · "}
                        {PAYMENT_METHOD_LABELS[payment.method]}
                        {payment.method === "credit" && payment.installments && payment.installments > 1 ? ` · ${payment.installments} תשלומים` : ""}{" "}
                        {access.canRecord && !cancelled ? null : <Badge tone={STATUS_TONES[payment.status]}>{PAYMENT_STATUS_LABELS[payment.status]}</Badge>}
                      </p>
                      <p className="text-sm text-ink-soft">
                        {formatDate(`${payment.paidOn}T12:00:00Z`)}
                        {payment.reference ? (
                          <>
                            {" · אסמכתא "}
                            <bdi dir="ltr">{payment.reference}</bdi>
                          </>
                        ) : null}
                        {recorder ? ` · נרשם על ידי ${recorder}` : ""}
                      </p>
                      {payment.note ? <p className="text-sm break-words whitespace-pre-line">{payment.note}</p> : null}
                      {cancelled ? (
                        <p className="text-sm break-words text-ink-soft">
                          בוטל{payment.cancelledAt ? ` ב-${formatDate(payment.cancelledAt)}` : ""}
                          {payment.cancelledBy && names.get(payment.cancelledBy) ? ` על ידי ${names.get(payment.cancelledBy)}` : ""}
                          {payment.cancelReason ? (
                            <>
                              : <bdi>{payment.cancelReason}</bdi>
                            </>
                          ) : null}
                        </p>
                      ) : null}
                      <HolderFiles
                        orgId={orgId}
                        page={subject}
                        holder={{ kind: "payment", id: payment.id }}
                        files={files.get(payment.id)}
                        names={uploaders}
                        canRecord={access.canRecord}
                        label={label}
                      />
                    </div>
                    {access.canRecord && !cancelled ? (
                      <span className="flex shrink-0 flex-wrap items-start gap-1">
                        <PaymentStatusSelect
                          orgId={orgId}
                          subject={subject}
                          paymentId={payment.id}
                          status={payment.status}
                          canCorrect={access.canCorrect}
                          label={label}
                        />
                        {access.canCorrect ? (
                          <>
                            <CorrectPaymentButton
                              orgId={orgId}
                              subject={subject}
                              paymentId={payment.id}
                              today={today}
                              label={label}
                              initial={{
                                amount: agorotInput(payment.amountAgorot),
                                paid_on: payment.paidOn,
                                method: payment.method,
                                installments: payment.installments ? String(payment.installments) : "1",
                                reference: payment.reference ?? "",
                                note: payment.note ?? "",
                              }}
                            />
                            <CancelPaymentButton orgId={orgId} subject={subject} paymentId={payment.id} label={label} />
                          </>
                        ) : null}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {/* LST-09: the business-wide list */}
        <p className="border-t border-line px-4 py-2 text-sm">
          <Link href={paymentsPath(orgId)} className="text-accent-strong underline-offset-4 hover:underline">
            לכל התשלומים
          </Link>
        </p>
      </CardBody>
    </Card>
  );
}
