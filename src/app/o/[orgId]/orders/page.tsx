import type { Metadata } from "next";
import Link from "next/link";

import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { OrderListItems } from "@/features/orders/components/order-list-items";
import { isFiltered, orderListFilters, orderListHref } from "@/features/orders/list";
import { ordersPath } from "@/features/orders/paths";
import { BILLING_STATE_LABELS, BILLING_STATES, PAYMENT_STATE_LABELS, PAYMENT_STATES } from "@/features/orders/money";
import { getOrderMoney, listOrders } from "@/features/orders/queries";
import { ORDER_SOURCES, ORDER_STATUS_LABELS, ORDER_STATUSES } from "@/features/orders/schema";
import { orderSourceLabels, ordersListTexts } from "@/features/orders/texts";
import { listMembers, orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { getOrgTerms } from "@/features/terminology/queries";

export const metadata: Metadata = { title: "הזמנות" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * ORD-01, ORD-06 part one: every order the user reads, newest first, filtered by status, source, the person responsible and
 * order date. Orders are made from a quote, a deal, a contact or a company. Documents and payments join with DOC/PAY.
 */
export default async function OrdersPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const filters = orderListFilters(await searchParams);
  await getOrgContext(orgId);
  const [hasDocuments, hasPayments] = await Promise.all([orgHasFeature(orgId, "documents"), orgHasFeature(orgId, "payments")]);
  // ORD-02: a billing or payment filter counts only while its plan key is on
  if (!hasDocuments) filters.billing = null;
  if (!hasPayments) filters.payment = null;
  const [{ orders, hasMore }, members, terms] = await Promise.all([listOrders(orgId, filters), listMembers(orgId), getOrgTerms(orgId)]);
  // ORD-02: the page's billing and payment states, in one call (RLS decides what counts)
  const money =
    hasDocuments || hasPayments
      ? { states: await getOrderMoney(orgId, orders.filter((o) => o.status !== "draft").map((o) => o.id)), billing: hasDocuments, payments: hasPayments }
      : undefined;
  // RVW-49: the business's own words (FLD-10)
  const texts = ordersListTexts(terms);
  const sourceLabels = orderSourceLabels(terms);
  const filtered = isFiltered(filters);

  return (
    <>
      <PageHeader
        title="הזמנות"
        description={texts.description}
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
        <label>
          <span className="mb-1.5 block text-sm font-medium">מקור</span>
          <Select name="source" defaultValue={filters.source ?? ""} className="w-40">
            <option value="">הכול</option>
            {ORDER_SOURCES.map((s) => (
              <option key={s} value={s}>
                {sourceLabels[s]}
              </option>
            ))}
          </Select>
        </label>
        <label>
          <span className="mb-1.5 block text-sm font-medium">אחראי</span>
          <Select name="owner" defaultValue={filters.ownerId ?? ""} className="w-44">
            <option value="">כולם</option>
            {members
              .filter((member) => member.status === "active" || member.userId === filters.ownerId)
              .map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.name}
                </option>
              ))}
          </Select>
        </label>
        {hasDocuments ? (
          <label>
            <span className="mb-1.5 block text-sm font-medium">חיוב</span>
            <Select name="billing" defaultValue={filters.billing ?? ""} className="w-40">
              <option value="">הכול</option>
              {BILLING_STATES.map((s) => (
                <option key={s} value={s}>
                  {BILLING_STATE_LABELS[s]}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
        {hasPayments ? (
          <label>
            <span className="mb-1.5 block text-sm font-medium">תשלום</span>
            <Select name="payment" defaultValue={filters.payment ?? ""} className="w-40">
              <option value="">הכול</option>
              {PAYMENT_STATES.map((s) => (
                <option key={s} value={s}>
                  {PAYMENT_STATE_LABELS[s]}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
        <label>
          <span className="mb-1.5 block text-sm font-medium">מתאריך</span>
          <Input type="date" name="from" defaultValue={filters.from ?? ""} className="w-40" />
        </label>
        <label>
          <span className="mb-1.5 block text-sm font-medium">עד תאריך</span>
          <Input type="date" name="to" defaultValue={filters.to ?? ""} className="w-40" />
        </label>
        <button type="submit" className={buttonClasses("secondary", "md")}>
          הצגה
        </button>
        {filtered ? (
          <Link href={ordersPath(orgId)} className={buttonClasses("ghost", "md")}>
            ניקוי הסינון
          </Link>
        ) : null}
      </form>
      {orders.length === 0 ? (
        <Card>
          <EmptyState
            title={filtered ? "אין הזמנות לפי הסינון" : "עוד אין הזמנות"}
            description={filtered ? "נסו סינון אחר, או נקו אותו." : texts.empty}
          />
        </Card>
      ) : (
        <ul aria-label="הזמנות" className="divide-y divide-line rounded-lg border border-line bg-surface">
          <OrderListItems orgId={orgId} orders={orders} money={money} />
        </ul>
      )}
      <Pagination page={filters.page} hasMore={hasMore} hrefFor={(target) => orderListHref(orgId, filters, target)} className="mt-4" />
    </>
  );
}
