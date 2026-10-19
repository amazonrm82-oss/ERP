import type { Metadata } from "next";
import Link from "next/link";

import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { Select } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { OrderListItems } from "@/features/orders/components/order-list-items";
import { ordersPath } from "@/features/orders/paths";
import { listOrders, type OrderListFilters } from "@/features/orders/queries";
import { isOrderStatus, ORDER_STATUS_LABELS, ORDER_STATUSES } from "@/features/orders/schema";
import { getOrgContext } from "@/features/shell/queries";
import { parsePage } from "@/lib/search";

export const metadata: Metadata = { title: "הזמנות" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

function listHref(orgId: string, filters: OrderListFilters, page: number): string {
  const query = new URLSearchParams();
  if (filters.status) query.set("status", filters.status);
  if (page > 1) query.set("page", String(page));
  const text = query.toString();
  return text ? `${ordersPath(orgId)}?${text}` : ordersPath(orgId);
}

/** ORD-01: every order the user reads, newest first, by status. Orders are made from a quote, a deal, a contact or a company. */
export default async function OrdersPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const query = await searchParams;
  const status = one(query.status);
  const filters: OrderListFilters = { status: isOrderStatus(status) ? status : null, page: parsePage(query.page) };
  await getOrgContext(orgId);
  const { orders, hasMore } = await listOrders(orgId, filters);

  return (
    <>
      <PageHeader
        title="הזמנות"
        description="כל ההזמנות של העסקאות, אנשי הקשר והחברות שאתם רואים. הזמנה יוצרים מהצעת מחיר שאושרה, מעסקה שנסגרה בהצלחה, או ידנית מכרטיס של איש קשר, חברה או עסקה."
      />
      <form method="get" action={ordersPath(orgId)} className="mb-5 flex flex-wrap items-end gap-3" aria-label="סינון הזמנות">
        <label>
          <span className="mb-1.5 block text-sm font-medium">מצב</span>
          <Select name="status" defaultValue={filters.status ?? ""} className="w-40">
            <option value="">הכול</option>
            {ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ORDER_STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        </label>
        <button type="submit" className={buttonClasses("secondary", "md")}>
          הצגה
        </button>
        {filters.status ? (
          <Link href={ordersPath(orgId)} className={buttonClasses("ghost", "md")}>
            ניקוי הסינון
          </Link>
        ) : null}
      </form>
      {orders.length === 0 ? (
        <Card>
          <EmptyState
            title={filters.status ? "אין הזמנות לפי הסינון" : "עוד אין הזמנות"}
            description={filters.status ? "נסו סינון אחר, או נקו אותו." : 'הזמנה יוצרים מהצעת מחיר שאושרה, מעסקה שנסגרה, או בכרטיס "הזמנות" של איש קשר, חברה או עסקה.'}
          />
        </Card>
      ) : (
        <ul aria-label="הזמנות" className="divide-y divide-line rounded-lg border border-line bg-surface">
          <OrderListItems orgId={orgId} orders={orders} />
        </ul>
      )}
      <Pagination page={filters.page} hasMore={hasMore} hrefFor={(target) => listHref(orgId, filters, target)} className="mt-4" />
    </>
  );
}
