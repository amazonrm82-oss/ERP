import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { TextLink } from "@/components/ui/text-link";
import {
  AddLineButton,
  BillingStatusActions,
  CycleDocumentForm,
  DeleteLineButton,
  EditBillingForm,
  SkipCycleButton,
} from "@/features/recurring-billing/components/billing-forms";
import { recurringBillingsPath } from "@/features/recurring-billing/paths";
import { getBilling, getRecurringAccess, listOfferableProducts } from "@/features/recurring-billing/queries";
import { BILLING_STATUS_LABELS, BILLING_STATUS_TONE, CYCLE_STATUS_LABELS, EVENT_LABELS } from "@/features/recurring-billing/schema";
import { commitmentEnd, CYCLE_LABELS } from "@/features/recurring-billing/schedule";
import { billingAmountText, billingDayText, nextCycleText } from "@/features/recurring-billing/texts";
import { orderPath } from "@/features/orders/paths";
import { getOrgContext, getUserNames } from "@/features/shell/queries";
import { formatDate, formatDateTime, formatMoney, zoneDate } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";

export const metadata: Metadata = { title: "חיוב חוזר" };

type Props = { params: Promise<{ orgId: string; billingId: string }> };

/**
 * SUB-01..SUB-04: one recurring billing: its schedule and status (pause, resume, cancel with a reason), its lines (a change
 * applies from the next cycle and is recorded), its cycles (SUB-02 method A: each cycle makes a task for the rep to issue the
 * document outside the system; the recorded document is linked here) and its history. Read with the user's session.
 */
export default async function RecurringBillingPage({ params }: Props) {
  const { orgId, billingId } = await params;
  if (!isUuid(billingId)) notFound();
  const [detail, access, context] = await Promise.all([getBilling(orgId, billingId), getRecurringAccess(orgId), getOrgContext(orgId)]);
  if (!detail) notFound();
  const { billing, lines, cycles, events, documents } = detail;
  const editable = access.canManage && billing.status !== "cancelled";
  const today = zoneDate(new Date(), context.org.timeZone);
  const commitment = commitmentEnd(billing.startDate, billing.commitmentMonths);
  const products = editable ? await listOfferableProducts(orgId) : [];
  const names = await getUserNames(events.map((e) => e.actorId));
  const customerHref = billing.contactId ? paths.contact(orgId, billing.contactId) : paths.company(orgId, billing.companyId ?? "");
  const documentLabel = new Map(documents.map((d) => [d.id, d.label]));

  return (
    <>
      <PageHeader
        title={billing.name}
        description={`${billingAmountText(billing.amountAgorot, billing.cycle)} · ${nextCycleText(billing.status, billing.nextCycleOn, billing.endDate)}`}
        back={{ href: recurringBillingsPath(orgId), label: "לכל החיובים החוזרים" }}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={BILLING_STATUS_TONE[billing.status]}>{BILLING_STATUS_LABELS[billing.status]}</Badge>
            {access.canStop ? (
              <BillingStatusActions
                orgId={orgId}
                billingId={billing.id}
                status={billing.status}
                commitmentEnd={commitment !== null && today <= commitment ? commitment : null}
                canResume={access.canManage}
              />
            ) : null}
          </span>
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="פרטים" />
          <CardBody className="space-y-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-ink-soft">לקוח</dt>
              <dd>
                <TextLink href={customerHref}>
                  <bdi>{billing.customerName || "לקוח"}</bdi>
                </TextLink>
              </dd>
              <dt className="text-ink-soft">מחזור</dt>
              <dd>{CYCLE_LABELS[billing.cycle]}</dd>
              <dt className="text-ink-soft">התחלה</dt>
              <dd>{formatDate(billing.startDate)}</dd>
              <dt className="text-ink-soft">התחייבות</dt>
              <dd>{commitment ? `${billing.commitmentMonths} חודשים, עד ${formatDate(commitment)}` : "בלי התחייבות"}</dd>
              {billing.dealId ? (
                <>
                  <dt className="text-ink-soft">עסקה</dt>
                  <dd>
                    <TextLink href={paths.deal(orgId, billing.dealId)}>העסקה שממנה נוצר</TextLink>
                  </dd>
                </>
              ) : null}
              <dt className="text-ink-soft">מחירים</dt>
              <dd>{billing.pricesIncludeVat ? 'כולל מע"מ' : 'לפני מע"מ'}</dd>
              {billing.cancelReason ? (
                <>
                  <dt className="text-ink-soft">סיבת הביטול</dt>
                  <dd className="break-words">
                    <bdi>{billing.cancelReason}</bdi>
                  </dd>
                </>
              ) : null}
            </dl>
            {editable ? (
              <EditBillingForm
                orgId={orgId}
                billingId={billing.id}
                values={{ name: billing.name, billingDay: billing.billingDay, endDate: billing.endDate, commitmentMonths: billing.commitmentMonths }}
              />
            ) : (
              <p className="text-sm text-ink-soft">
                יום החיוב: {billingDayText(billing.billingDay)}{billing.endDate ? ` · עד ${formatDate(billing.endDate)}` : " · עד הודעה חדשה"}
              </p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={`שורות (${lines.length})`} action={editable ? <AddLineButton orgId={orgId} billingId={billing.id} products={products} /> : null} />
          <CardBody>
            {lines.length === 0 ? (
              <p className="text-sm text-ink-soft">אין עדיין שורות. מחזור בלי שורות נרשם בסכום 0.</p>
            ) : (
              <ul className="divide-y divide-line">
                {lines.map((line) => (
                  <li key={line.id} className="flex flex-wrap items-start justify-between gap-2 py-2 first:pt-0 last:pb-0">
                    <span className="min-w-0">
                      <span className="block break-words">{line.description}</span>
                      <span className="block text-sm text-ink-soft">
                        {line.quantity.toLocaleString("he-IL")} × {formatMoney(line.unitPriceAgorot)}
                        {line.priceListName ? ` · מחירון ${line.priceListName}` : ""}
                        {line.vatExempt ? ' · פטור ממע"מ' : ""}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums">{formatMoney(line.totalAgorot)}</span>
                      {editable ? <DeleteLineButton orgId={orgId} billingId={billing.id} lineId={line.id} /> : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-sm text-ink-soft">שינוי בשורות חל מהמחזור הבא ונרשם בהיסטוריה. מחזורים שכבר נוצרו שומרים את הסכום שלהם.</p>
          </CardBody>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title={`מחזורים (${cycles.length})`} />
        <CardBody>
          <p className="mb-3 text-sm text-ink-soft">
            בכל מחזור נוצרת משימה לנציג: להפיק מסמך ללקוח במערכת החשבונות, לרשום אותו במסמכים ולשייך אותו כאן. שום דבר לא נשלח ללקוח אוטומטית.
          </p>
          {cycles.length === 0 ? (
            <p className="text-sm text-ink-soft">עוד לא נוצרו מחזורים.</p>
          ) : (
            <ul className="divide-y divide-line">
              {cycles.map((cycle) => (
                <li key={cycle.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span>
                      <span className="block font-medium">
                        {formatDate(cycle.cycleOn)} עד {formatDate(cycle.periodEnd)}
                      </span>
                      <span className="block text-sm text-ink-soft">
                        {formatMoney(cycle.netAgorot)} לפני מע&quot;מ · {formatMoney(cycle.totalAgorot)} לתשלום
                        {cycle.documentId ? ` · ${documentLabel.get(cycle.documentId) ?? "מסמך"}` : ""}
                      </span>
                      {cycle.orderId ? (
                        <TextLink href={orderPath(orgId, cycle.orderId)} className="text-sm">
                          טיוטת ההזמנה של המחזור
                        </TextLink>
                      ) : null}
                    </span>
                    <Badge tone={cycle.status === "due" ? "warning" : cycle.status === "documented" ? "success" : "neutral"}>{CYCLE_STATUS_LABELS[cycle.status] ?? cycle.status}</Badge>
                  </div>
                  {access.canManage ? (
                    <div className="flex flex-wrap items-end gap-2">
                      {cycle.status !== "skipped" ? (
                        <CycleDocumentForm orgId={orgId} billingId={billing.id} cycleId={cycle.id} documentId={cycle.documentId} documents={documents} />
                      ) : null}
                      {cycle.status !== "documented" ? <SkipCycleButton orgId={orgId} billingId={billing.id} cycleId={cycle.id} skipped={cycle.status === "skipped"} /> : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardHeader title="היסטוריה" />
        <CardBody>
          <ul className="space-y-2 text-sm">
            {events.map((event) => (
              <li key={event.id} className="break-words">
                <span className="text-ink-soft">{formatDateTime(event.createdAt)}</span> · {EVENT_LABELS[event.kind] ?? event.kind}
                {event.kind === "price_changed" && event.oldAmount !== null && event.newAmount !== null
                  ? `: ${formatMoney(event.oldAmount)} ← ${formatMoney(event.newAmount)}`
                  : ""}
                {event.kind === "cycles_skipped" && event.skippedCycles ? ` (${event.skippedCycles})` : ""}
                {event.kind === "resumed" && event.makeUp !== null ? (event.makeUp ? ": עם השלמת המחזורים שעברו" : ": בלי השלמת המחזורים שעברו") : ""}
                {event.kind === "cancelled" && event.inCommitment ? " בתוך תקופת ההתחייבות" : ""}
                {event.kind === "cancelled" && event.reason ? (
                  <>
                    {" · סיבה: "}
                    <bdi>{event.reason}</bdi>
                  </>
                ) : null}
                {event.effectiveOn && event.kind !== "cycle_due" && event.kind !== "cancelled" ? ` · מחזור ${formatDate(event.effectiveOn)}` : ""}
                {event.actorId && names.get(event.actorId) ? ` · ${names.get(event.actorId)}` : ""}
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </>
  );
}
