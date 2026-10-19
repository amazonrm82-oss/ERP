import "@/features/print/print.css";

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/ui/page-header";
import { OrderDocument } from "@/features/orders/components/order-document";
import { getOrderDocumentData, LIVE_BILLING_NOTE } from "@/features/orders/document-server";
import { orderPath } from "@/features/orders/paths";
import { getOrder } from "@/features/orders/queries";
import { PrintButton } from "@/features/print/components/print-button";
import { getOrgContext } from "@/features/shell/queries";
import { isUuid } from "@/lib/paths";

export const metadata: Metadata = { title: "אישור הזמנה להדפסה" };

type Props = { params: Promise<{ orgId: string; orderId: string }> };

/**
 * ORD-05 part one: an order confirmation as its customer sees it, for printing or saving as PDF from the browser (the
 * agreed fallback until the PDF module, QUO-06). Whoever reads the order reads this page.
 */
export default async function OrderDocumentPage({ params }: Props) {
  const { orgId, orderId } = await params;
  if (!isUuid(orderId)) notFound();
  const context = await getOrgContext(orgId);
  const order = await getOrder(orgId, orderId);
  if (!order) notFound();
  const data = await getOrderDocumentData(orgId, order, context.org.name);
  const title = order.numberDisplay ? `הזמנה ${order.numberDisplay}` : "הזמנה בטיוטה";
  return (
    <div className="max-w-4xl space-y-4">
      <div data-print-page="" className="print:hidden">
        <PageHeader title="תצוגה והדפסה" back={{ href: orderPath(orgId, order.id), label: title }} actions={<PrintButton label="הדפסה או שמירה כ-PDF" />} />
        {order.status === "draft" ? <p className="text-sm text-ink-soft">זו טיוטה: היא מודפסת בלי מספר, ומספר רץ ניתן באישור ההזמנה.</p> : null}
        {order.status === "cancelled" ? <p className="text-sm text-ink-soft">ההזמנה בוטלה.</p> : null}
        {order.status !== "draft" ? <p className="text-sm text-ink-soft">{LIVE_BILLING_NOTE}</p> : null}
      </div>
      <OrderDocument data={data} headingLevel={2} />
    </div>
  );
}
