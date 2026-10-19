import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { formatDate, formatMoney } from "@/lib/format";

import { orderPath } from "../paths";
import type { OrderSummary } from "../queries";
import { ORDER_STATUS_LABELS, type OrderStatus } from "../schema";

const TONES: Partial<Record<OrderStatus, "success" | "warning" | "danger" | "neutral">> = {
  delivered: "success",
  partly_delivered: "warning",
  cancelled: "danger",
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return <Badge tone={TONES[status] ?? "neutral"}>{ORDER_STATUS_LABELS[status]}</Badge>;
}

/** One line per order: number (or "טיוטה"), customer, dates, status and total. */
export function OrderListItems({ orgId, orders, showCustomer = true }: { orgId: string; orders: OrderSummary[]; showCustomer?: boolean }) {
  return (
    <>
      {orders.map((order) => (
        <li key={order.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3">
          <div className="min-w-0">
            <Link href={orderPath(orgId, order.id)} className="font-medium text-accent-strong underline-offset-4 hover:underline">
              {order.numberDisplay ? (
                <span dir="ltr" className="tabular-nums">
                  {order.numberDisplay}
                </span>
              ) : (
                "הזמנה בטיוטה"
              )}
            </Link>
            <p className="text-sm text-ink-soft">
              {showCustomer && order.customer ? (
                <>
                  <bdi>{order.customer}</bdi>
                  {" · "}
                </>
              ) : null}
              {formatDate(order.orderDate)}
              {order.deliveryDate ? ` · אספקה ${formatDate(order.deliveryDate)}` : ""}
            </p>
          </div>
          <span className="flex items-center gap-2 text-sm">
            <OrderStatusBadge status={order.status} />
            <span className="font-medium whitespace-nowrap tabular-nums">{formatMoney(order.totalAgorot)}</span>
          </span>
        </li>
      ))}
    </>
  );
}
