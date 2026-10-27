import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { formatDate, formatMoney } from "@/lib/format";

import { BILLING_STATE_LABELS, moneyStateTone, PAYMENT_STATE_LABELS, showsMoneyBadges, type OrderMoney } from "../money";
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

type MoneyBadges = { states: Map<string, OrderMoney>; billing: boolean; payments: boolean };

/** One line per order: number (or "טיוטה"), customer, dates, status and total; with `money`, its billing and payment states. */
export function OrderListItems({ orgId, orders, showCustomer = true, money }: { orgId: string; orders: OrderSummary[]; showCustomer?: boolean; money?: MoneyBadges }) {
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
          <span className="flex flex-wrap items-center gap-2 text-sm">
            <OrderStatusBadge status={order.status} />
            {money ? <OrderMoneyBadges status={order.status} state={money.states.get(order.id)} billing={money.billing} payments={money.payments} /> : null}
            <span className="font-medium whitespace-nowrap tabular-nums">{formatMoney(order.totalAgorot)}</span>
          </span>
        </li>
      ))}
    </>
  );
}

/** ORD-02: the order's billing and payment states (none for a draft). */
function OrderMoneyBadges({ status, state, billing, payments }: { status: OrderStatus; state: OrderMoney | undefined; billing: boolean; payments: boolean }) {
  // a cancelled order with no document or payment shows none
  if (!state || !showsMoneyBadges(status, state)) return null;
  return (
    <>
      {billing && state.billingState ? <Badge tone={moneyStateTone(state.billingState)}>{BILLING_STATE_LABELS[state.billingState]}</Badge> : null}
      {payments && state.paymentState ? <Badge tone={moneyStateTone(state.paymentState)}>{PAYMENT_STATE_LABELS[state.paymentState]}</Badge> : null}
    </>
  );
}
