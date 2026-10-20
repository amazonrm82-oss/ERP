import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { PageHeader } from "@/components/ui/page-header";
import { confirmOrderAction, deleteOrderAction, deleteOrderLineAction, setOrderStatusAction } from "@/features/orders/actions";
import { OrderDetailsForm } from "@/features/orders/components/order-details-form";
import { OrderStatusBadge } from "@/features/orders/components/order-list-items";
import { OrderLineForm } from "@/features/orders/components/order-line-form";
import { OrderStatusControl } from "@/features/orders/components/order-status-control";
import { orderDocumentPath, orderPath, ordersPath } from "@/features/orders/paths";
import { ButtonLink } from "@/components/ui/button";
import { getOrder, getOrderParties, getOrderPricing, listOrderLines, listOrderSchedule } from "@/features/orders/queries";
import { PaymentScheduleCard } from "@/features/quotes/components/quote-schedule-card";
import { orderEditing, ORDER_SOURCE_LABELS } from "@/features/orders/schema";
import { quotePath } from "@/features/quotes/paths";
import { priceSourceText } from "@/features/deal-lines/schema";
import { orgHasFeature } from "@/features/settings/queries";
import { canEditRecordHint, getOrgContext } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { formatDate, formatMoney } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "הזמנה" };

type Props = { params: Promise<{ orgId: string; orderId: string }> };

const linkClass = "text-accent-strong underline-offset-4 hover:underline";

const BILLING_LABELS: Record<string, string> = { monthly: "חודשי", quarterly: "רבעוני", yearly: "שנתי" };

/**
 * ORD-01 / ORD-02 / ORD-03: one order. Whoever reads its deal (else contact, else company) reads it; whoever may edit that
 * record edits it: lines only while it is a draft, the delivery details until it is cancelled (RLS decides again).
 */
export default async function OrderPage({ params }: Props) {
  const { orgId, orderId } = await params;
  if (!isUuid(orderId)) notFound();
  const context = await getOrgContext(orgId);
  const order = await getOrder(orgId, orderId);
  if (!order) notFound();
  const supabase = await createClient();
  const parentQuery = order.dealId
    ? supabase.from("deals").select("owner_id, deleted_at").eq("organization_id", orgId).eq("id", order.dealId).maybeSingle()
    : order.contactId
      ? supabase.from("contacts").select("owner_id, deleted_at").eq("organization_id", orgId).eq("id", order.contactId).maybeSingle()
      : order.companyId
        ? supabase.from("companies").select("owner_id, deleted_at").eq("organization_id", orgId).eq("id", order.companyId).maybeSingle()
        : null;
  const [lines, parties, parent, schedule] = await Promise.all([
    listOrderLines(orgId, order.id),
    getOrderParties(orgId, order),
    parentQuery,
    listOrderSchedule(orgId, order.id),
  ]);
  const parentRow = parent ? must(parent, "order parent") : null;
  const mayEdit = parentRow !== null && parentRow.deleted_at === null && canEditRecordHint(context, parentRow.owner_id);
  const editing = orderEditing(order.status);
  // a draft's new lines are priced like deal lines (PL-03): the order's day, VAT mode and the customer's price list
  const [pricing, hasProducts, hasDiscounts] =
    mayEdit && editing.lines
      ? await Promise.all([getOrderPricing(orgId, order), orgHasFeature(orgId, "products"), orgHasFeature(orgId, "discounts")])
      : [null, false, false];
  const back = order.dealId
    ? { href: paths.deal(orgId, order.dealId), label: parties.deal ?? "עסקה" }
    : order.contactId
      ? { href: paths.contact(orgId, order.contactId), label: parties.contact ?? "איש קשר" }
      : order.companyId
        ? { href: paths.company(orgId, order.companyId), label: parties.company ?? "חברה" }
        : { href: ordersPath(orgId), label: "הזמנות" };
  const title = order.numberDisplay ? `הזמנה ${order.numberDisplay}` : "הזמנה בטיוטה";

  return (
    <div className="max-w-4xl">
      <PageHeader
        title={title}
        back={back}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* ORD-05 part one: the confirmation as the customer sees it, to print or save as PDF */}
            <ButtonLink href={orderDocumentPath(orgId, order.id)} variant="secondary" size="sm">
              תצוגה והדפסה
            </ButtonLink>
            {mayEdit && order.status === "draft" ? (
              <>
                <ConfirmButton
                  variant="primary"
                  size="sm"
                  title="לאשר את ההזמנה?"
                  description="ההזמנה תקבל מספר רץ, והשורות והמחירים שלה יינעלו. מועד האספקה, כתובת המשלוח וההערות נשארים לעריכה. הזמנה שאושרה לא נמחקת, רק מבוטלת."
                  confirmLabel="אישור ההזמנה"
                  action={confirmOrderAction.bind(null, orgId, order.id)}
                >
                  אישור ההזמנה
                </ConfirmButton>
                <ConfirmButton
                  title="למחוק את הטיוטה?"
                  description="הטיוטה והשורות שלה יימחקו. אי אפשר לשחזר אותן."
                  confirmLabel="מחיקת הטיוטה"
                  action={deleteOrderAction.bind(null, orgId, order.id)}
                >
                  מחיקה
                </ConfirmButton>
              </>
            ) : null}
            {mayEdit && editing.status ? (
              <ConfirmButton
                title="לבטל את ההזמנה?"
                description="ההזמנה תסומן כמבוטלת ותישאר ברשימה עם המספר שלה. אי אפשר להחזיר הזמנה מבוטלת."
                confirmLabel="ביטול ההזמנה"
                action={setOrderStatusAction.bind(null, orgId, order.id, "cancelled")}
              >
                ביטול ההזמנה
              </ConfirmButton>
            ) : null}
          </div>
        }
      />
      <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-ink-soft">
        <OrderStatusBadge status={order.status} />
        <span>{ORDER_SOURCE_LABELS[order.source]}</span>
        <span>תאריך {formatDate(order.orderDate)}</span>
        {order.cancelledAt ? <span>בוטלה {formatDate(order.cancelledAt)}</span> : null}
        {order.customerName ? (
          <span>
            לקוח: <bdi className="text-ink">{order.customerName}</bdi>
          </span>
        ) : null}
        {order.customerDeletedAt ? <span>הלקוח נמחק</span> : null}
        {order.quoteId ? (
          <Link href={quotePath(orgId, order.quoteId)} className={linkClass}>
            הצעת מחיר {parties.quote ? <bdi dir="ltr">{parties.quote}</bdi> : null}
          </Link>
        ) : null}
        {order.originalOrderId ? (
          <Link href={orderPath(orgId, order.originalOrderId)} className={linkClass}>
            תוספת להזמנה {parties.original ? <bdi dir="ltr">{parties.original}</bdi> : null}
          </Link>
        ) : null}
      </div>
      {order.status === "draft" ? (
        <p className="mb-5 text-sm text-ink-soft">טיוטה: אפשר להוסיף ולמחוק שורות. באישור ההזמנה היא מקבלת מספר והשורות והמחירים ננעלים.</p>
      ) : order.source === "quote" ? (
        <p className="mb-5 text-sm text-ink-soft">השורות והמחירים הם כפי שהלקוח אישר בהצעה. שינוי מחיר עובר דרך תוספת להצעה.</p>
      ) : null}

      <div className="space-y-5">
        <Card aria-labelledby="order-customer">
          <CardHeader id="order-customer" title="לקוח" />
          <CardBody className="space-y-1 text-sm">
            {order.contactId ? (
              <p>
                איש קשר:{" "}
                <Link href={paths.contact(orgId, order.contactId)} className={linkClass}>
                  <bdi>{parties.contact ?? "איש קשר"}</bdi>
                </Link>
              </p>
            ) : null}
            {order.companyId ? (
              <p>
                חברה:{" "}
                <Link href={paths.company(orgId, order.companyId)} className={linkClass}>
                  <bdi>{parties.company ?? "חברה"}</bdi>
                </Link>
              </p>
            ) : null}
            {order.dealId ? (
              <p>
                עסקה:{" "}
                <Link href={paths.deal(orgId, order.dealId)} className={linkClass}>
                  <bdi>{parties.deal ?? "עסקה"}</bdi>
                </Link>
              </p>
            ) : null}
            {!order.contactId && !order.companyId && !order.dealId ? <p className="text-ink-soft">הלקוח של ההזמנה נמחק.</p> : null}
          </CardBody>
        </Card>

        {mayEdit && editing.status ? (
          <Card aria-labelledby="order-status">
            <CardHeader id="order-status" title="מצב" />
            <CardBody>
              <OrderStatusControl orgId={orgId} orderId={order.id} status={order.status} />
            </CardBody>
          </Card>
        ) : null}

        <Card aria-labelledby="order-lines">
          <CardHeader id="order-lines" title="שורות" />
          <CardBody className="space-y-4">
            {lines.length === 0 ? (
              <p className="text-sm text-ink-soft">עוד אין שורות בהזמנה.</p>
            ) : (
              <ul className="divide-y divide-line">
                {lines.map((line) =>
                  line.kind === "group" ? (
                    <li key={line.id} className="py-2 font-medium first:pt-0">
                      <bdi>{line.name}</bdi>
                    </li>
                  ) : (
                    <li key={line.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium break-words">
                          <bdi>{line.name}</bdi>
                        </p>
                        {line.description ? <p className="text-sm break-words text-ink-soft">{line.description}</p> : null}
                        <p className="text-sm text-ink-soft">
                          <span className="tabular-nums">{line.quantity}</span>
                          {line.unitName ? ` ${line.unitName}` : ""} × <span className="tabular-nums">{formatMoney(line.unitPriceAgorot)}</span>
                          {BILLING_LABELS[line.billing] ? ` · ${BILLING_LABELS[line.billing]}` : ""}
                          {line.discountBp ? ` · הנחה ${line.discountBp / 100}%` : line.discountAgorot ? ` · הנחה ${formatMoney(line.discountAgorot)}` : ""}
                          {line.vatExempt ? ' · פטור ממע"מ' : ""}
                          {line.productId ? ` · ${priceSourceText(line.priceSource, line.priceListName)}` : ""}
                        </p>
                      </div>
                      <span className="flex items-center gap-2">
                        <span className="font-medium whitespace-nowrap tabular-nums">{formatMoney(line.totalAgorot)}</span>
                        {mayEdit && editing.lines ? (
                          <ConfirmButton title="למחוק את השורה?" confirmLabel="מחיקה" action={deleteOrderLineAction.bind(null, orgId, order.id, line.id)}>
                            מחיקה
                          </ConfirmButton>
                        ) : null}
                      </span>
                    </li>
                  ),
                )}
              </ul>
            )}
            <dl className="space-y-1 border-t border-line pt-3 text-sm">
              {order.discountTotalAgorot > 0 ? (
                <div className="flex justify-between gap-4">
                  <dt>הנחה</dt>
                  <dd className="tabular-nums">−{formatMoney(order.discountTotalAgorot)}</dd>
                </div>
              ) : null}
              <div className="flex justify-between gap-4">
                <dt>לפני מע&quot;מ</dt>
                <dd className="tabular-nums">{formatMoney(order.netTotalAgorot)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>מע&quot;מ{order.vatRateBp !== null && order.vatRateBp > 0 ? ` (${order.vatRateBp / 100}%)` : ""}</dt>
                <dd className="tabular-nums">{formatMoney(order.vatAgorot)}</dd>
              </div>
              <div className="flex justify-between gap-4 font-medium">
                <dt>סה&quot;כ</dt>
                <dd className="tabular-nums">{formatMoney(order.totalAgorot)}</dd>
              </div>
            </dl>
            {pricing ? (
              <div className="border-t border-line pt-4">
                <h3 className="mb-3 text-md font-semibold">שורה חדשה</h3>
                <OrderLineForm orgId={orgId} orderId={order.id} pricing={pricing} products={hasProducts} discounts={hasDiscounts} />
              </div>
            ) : null}
          </CardBody>
        </Card>

        {/* ORD-04: the payment schedule (a quote's order carries the accepted quote's, locked); built while a draft */}
        <PaymentScheduleCard orgId={orgId} ownerId={order.id} kind="order" steps={schedule} totalAgorot={order.totalAgorot} canEdit={mayEdit && editing.lines} />

        <Card aria-labelledby="order-delivery">
          <CardHeader id="order-delivery" title="אספקה" />
          <CardBody>
            <OrderDetailsForm
              orgId={orgId}
              orderId={order.id}
              values={{
                deliveryDate: order.deliveryDate,
                shippingAddress: order.shippingAddress,
                notes: order.notes,
                deliveryContactId: order.deliveryContactId,
              }}
              deliveryContact={order.deliveryContactId ? { id: order.deliveryContactId, label: parties.deliveryContact ?? "איש קשר" } : null}
              editable={mayEdit && editing.details}
            />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
