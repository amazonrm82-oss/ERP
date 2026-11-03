import Link from "next/link";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { AllocateButton } from "@/features/allocations/components/allocation-forms";
import { AllocationRows } from "@/features/allocations/components/allocation-rows";
import { creditLine, NO_CREDIT } from "@/features/allocations/credit";
import { getAllocationAccess, getMoneyState, getSubjectCredit, listAllocations } from "@/features/allocations/queries";
import { agorotInput } from "@/features/deals/recurring";
import { HolderFiles } from "@/features/files/components/holder-files";
import { listHolderFiles } from "@/features/files/holder-queries";
import { getOrgContext } from "@/features/shell/queries";
import { formatDate, formatMoney, zoneDate } from "@/lib/format";

import { paymentsPath } from "../paths";
import type { MoneySubject } from "../money-subject";
import { getPaymentsAccess, listRecordPayments, listRefundCreditDocuments } from "../queries";
import { refundable, refundedLine } from "../refunds";
import { PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS, receivedTotal, type PaymentStatus } from "../schema";
import { bankLabel, CHEQUE_STATUS_LABELS } from "../cheques";
import { ChequeSeriesButton, ChequeStatusSelect } from "./cheque-forms";
import { advanceLine } from "../advance";
import { advanceLinkNumbers, listAdvanceTargets } from "../advance-queries";
import { CancelPaymentButton, CorrectPaymentButton, PaymentStatusSelect, RecordPaymentButton } from "./payment-forms";
import { CancelRefundButton, RefundPaymentButton } from "./refund-forms";

type Props = {
  orgId: string;
  subject: MoneySubject;
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
  // PAY-02: what each payment allocated to documents, and its credit
  const allocation = await getAllocationAccess(orgId);
  const ids = payments.map((p) => p.id);
  const [money, allocations, credit] = allocation.inPlan
    ? await Promise.all([getMoneyState(orgId, [], ids), listAllocations(orgId, { payments: ids }), getSubjectCredit(orgId, subject)])
    : [null, [], NO_CREDIT];
  // PAY-03: the customer's credit (this record's, and its company's contacts and deals')
  const creditText = creditLine(credit);
  // PAY-03: what a new payment may be an advance for, and the numbers the advances name
  const [advanceTargets, advanceNumbers] = await Promise.all([
    access.canRecord ? listAdvanceTargets(orgId, subject) : Promise.resolve([]),
    advanceLinkNumbers(
      orgId,
      payments.flatMap((p) => (p.advance ? [p.advance] : [])),
    ),
  ]);
  // PAY-08: the recorded credit invoices a refund may name (owners and admins refund)
  const creditDocuments = access.canCorrect
    ? (await listRefundCreditDocuments(orgId, subject)).map((doc) => ({
        id: doc.id,
        label: `חשבונית זיכוי${doc.number ? ` ${doc.number}` : ""} מ-${formatDate(`${doc.docDate}T12:00:00Z`)}`,
      }))
    : [];
  const today = zoneDate(new Date(), context.org.timeZone);
  const titleId = `payments-${subject.id}`;
  const total = receivedTotal(payments);
  return (
    <Card aria-labelledby={titleId} className="print:hidden">
      <CardHeader
        id={titleId}
        title="תשלומים"
        action={
          access.canRecord ? (
            <span className="flex flex-wrap gap-1">
              <RecordPaymentButton orgId={orgId} subject={subject} today={today} advanceTargets={advanceTargets} />
              <ChequeSeriesButton orgId={orgId} subject={subject} today={today} />
            </span>
          ) : null
        }
      />
      <CardBody className="p-0">
        {creditText ? <p className="border-b border-line px-4 py-2 text-sm font-medium">{creditText}</p> : null}
        {payments.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-soft">עוד לא נרשמו תשלומים. כאן רושמים כל תשלום שהתקבל: סכום, תאריך ואמצעי.</p>
        ) : (
          <>
            <p className="border-b border-line px-4 py-2 text-sm text-ink-soft">
              התקבלו <span className="font-medium text-ink tabular-nums">{formatMoney(total)}</span> (תשלומים במצב נרשם או אושר; לא נספרים תשלומים שבוטלו, נכשלו
              או הוחזרו; החזר חלקי מופחת)
            </p>
            <ul className="divide-y divide-line">
              {payments.map((payment) => {
                const label = `${formatMoney(payment.amountAgorot)} מ-${formatDate(`${payment.paidOn}T12:00:00Z`)}`;
                const recorder = payment.createdBy ? names.get(payment.createdBy) : undefined;
                const cancelled = payment.status === "cancelled";
                const muted = payment.status !== "recorded" && payment.status !== "confirmed";
                // PAY-08: what may still be refunded, and the refunds' line
                const remaining = refundable(payment, payment.refundedAgorot);
                const refundText = refundedLine(payment, payment.refundedAgorot);
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
                      {payment.cheque ? (
                        <p className="text-sm break-words text-ink-soft">
                          {"צ'ק "}
                          {payment.cheque.number ? <bdi dir="ltr">{payment.cheque.number}</bdi> : null}
                          {payment.cheque.bank ? ` · ${bankLabel(payment.cheque.bank, payment.cheque.bankName)}` : ""}
                          {payment.cheque.branch ? ` · סניף ${payment.cheque.branch}` : ""}
                          {payment.cheque.dueDate ? ` · לפירעון ${formatDate(`${payment.cheque.dueDate}T12:00:00Z`)}` : ""}
                          {` · ${CHEQUE_STATUS_LABELS[payment.cheque.status]}`}
                        </p>
                      ) : null}
                      {payment.advance ? (
                        <p className="text-sm text-ink-soft">
                          {advanceLine({
                            quoteNumber: payment.advance.quoteId ? advanceNumbers.quotes.get(payment.advance.quoteId) : null,
                            orderNumber: payment.advance.orderId ? advanceNumbers.orders.get(payment.advance.orderId) : null,
                          })}
                        </p>
                      ) : null}
                      {payment.cheque?.unbounceReason ? (
                        <p className="text-sm break-words text-ink-soft">
                          הוחזר ממצב &quot;חזר&quot;: <bdi>{payment.cheque.unbounceReason}</bdi>
                        </p>
                      ) : null}
                      {payment.note ? <p className="text-sm break-words whitespace-pre-line">{payment.note}</p> : null}
                      {refundText ? (
                        <p className="text-sm font-medium">
                          {refundText}: <span className="tabular-nums">{formatMoney(payment.refundedAgorot)}</span>
                          {remaining > 0 ? (
                            <>
                              {" · נספר "}
                              <span className="tabular-nums">{formatMoney(remaining)}</span>
                            </>
                          ) : null}
                        </p>
                      ) : null}
                      {payment.refunds.length > 0 ? (
                        <ul className="mt-1 space-y-1 border-s-2 border-line ps-3" aria-label={`ההחזרים של התשלום ${label}`}>
                          {payment.refunds.map((refund) => {
                            const refundLabel = `${formatMoney(refund.amountAgorot)} מ-${formatDate(`${refund.refundedOn}T12:00:00Z`)}`;
                            const refundCancelled = refund.status === "cancelled";
                            const by = refund.createdBy ? names.get(refund.createdBy) : undefined;
                            return (
                              <li key={refund.id} className="flex flex-wrap items-start justify-between gap-2 text-sm">
                                <div className="min-w-0 flex-1">
                                  <p className="break-words">
                                    {"החזר "}
                                    <span className={`tabular-nums ${refundCancelled ? "text-ink-soft line-through" : ""}`}>{formatMoney(refund.amountAgorot)}</span>
                                    {` · ${PAYMENT_METHOD_LABELS[refund.method]} · ${formatDate(`${refund.refundedOn}T12:00:00Z`)}`}
                                    {refund.reference ? (
                                      <>
                                        {" · אסמכתא "}
                                        <bdi dir="ltr">{refund.reference}</bdi>
                                      </>
                                    ) : null}
                                    {refund.creditDocumentId ? ` · ${creditDocuments.find((d) => d.id === refund.creditDocumentId)?.label ?? "חשבונית זיכוי"}` : ""}
                                    {by ? ` · נרשם על ידי ${by}` : ""}{" "}
                                    {refundCancelled ? <Badge tone="warning">בוטל</Badge> : null}
                                  </p>
                                  {refund.note ? <p className="break-words whitespace-pre-line text-ink-soft">{refund.note}</p> : null}
                                  {refundCancelled && refund.cancelReason ? (
                                    <p className="break-words text-ink-soft">
                                      בוטל{refund.cancelledAt ? ` ב-${formatDate(refund.cancelledAt)}` : ""}: <bdi>{refund.cancelReason}</bdi>
                                    </p>
                                  ) : null}
                                </div>
                                {access.canCorrect && !refundCancelled ? <CancelRefundButton orgId={orgId} subject={subject} refundId={refund.id} label={refundLabel} /> : null}
                              </li>
                            );
                          })}
                        </ul>
                      ) : null}
                      {money && !muted ? (
                        <p className="text-sm text-ink-soft">
                          שויך למסמכים <span className="tabular-nums">{formatMoney(money.payments.get(payment.id)?.allocated ?? 0)}</span>
                          {" · "}יתרת זכות <span className="tabular-nums">{formatMoney(money.payments.get(payment.id)?.credit ?? 0)}</span>
                        </p>
                      ) : null}
                      <AllocationRows
                        orgId={orgId}
                        page={subject}
                        side="payment"
                        allocations={allocations.filter((a) => a.paymentId === payment.id)}
                        canChange={allocation.canChange}
                      />
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
                        {allocation.canAllocate && !muted && (money?.payments.get(payment.id)?.credit ?? 0) > 0 ? (
                          <AllocateButton
                            orgId={orgId}
                            page={subject}
                            from={{ kind: "payment", id: payment.id, label }}
                            available={money?.payments.get(payment.id)?.credit ?? 0}
                          />
                        ) : null}
                        {payment.cheque && payment.status !== "refunded" ? (
                          <ChequeStatusSelect
                            orgId={orgId}
                            subject={subject}
                            paymentId={payment.id}
                            status={payment.cheque.status}
                            isAdmin={access.canCorrect}
                            label={label}
                          />
                        ) : (
                          <PaymentStatusSelect
                            orgId={orgId}
                            subject={subject}
                            paymentId={payment.id}
                            status={payment.status}
                            canCorrect={access.canCorrect}
                            hasRefunds={payment.refundedAgorot > 0}
                            label={label}
                          />
                        )}
                        {access.canCorrect && remaining > 0 ? (
                          <RefundPaymentButton
                            orgId={orgId}
                            subject={subject}
                            paymentId={payment.id}
                            label={label}
                            method={payment.method}
                            remaining={remaining}
                            today={today}
                            creditDocuments={creditDocuments}
                          />
                        ) : null}
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
                                cheque_number: payment.cheque?.number ?? "",
                                cheque_bank: payment.cheque?.bank ?? "",
                                cheque_bank_name: payment.cheque?.bankName ?? "",
                                cheque_branch: payment.cheque?.branch ?? "",
                                cheque_due_date: payment.cheque?.dueDate ?? "",
                                cheque_status: payment.cheque?.status ?? "",
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
