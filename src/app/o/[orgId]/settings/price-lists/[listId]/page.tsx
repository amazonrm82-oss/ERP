import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { BackIcon } from "@/components/ui/icons";
import { DeletePriceList } from "@/features/price-lists/components/delete-price-list";
import { PriceListForm } from "@/features/price-lists/components/price-list-form";
import { PriceListLineForm } from "@/features/price-lists/components/price-list-line-form";
import { PriceListLines } from "@/features/price-lists/components/price-list-lines";
import { PriceListStatusBadge } from "@/features/price-lists/components/price-list-status";
import { priceListsPath } from "@/features/price-lists/paths";
import { getPriceList, listPriceListLines, listPricingProducts } from "@/features/price-lists/queries";
import { validityText } from "@/features/price-lists/status";
import { PRICE_LISTS_NOT_IN_PLAN } from "@/features/price-lists/schema";
import { isOfferable } from "@/features/products/schema";
import { orgHasFeature } from "@/features/settings/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { zoneDate } from "@/lib/format";
import { isUuid } from "@/lib/paths";

export const metadata: Metadata = { title: "מחירון" };

type Props = { params: Promise<{ orgId: string; listId: string }> };

/**
 * PL-01, PL-02: one price list and its prices. Everyone reads it; owners and admins of a writable
 * organization edit it, add and remove prices, and remove the list.
 */
export default async function PriceListPage({ params }: Props) {
  const { orgId, listId } = await params;
  const { org, role, canWrite } = await getOrgContext(orgId);
  if (!isUuid(listId)) notFound();
  const list = await getPriceList(orgId, listId);
  if (!list) notFound();
  const editable = isAdminRole(role) && canWrite;
  const [lines, inPlan] = await Promise.all([listPriceListLines(orgId, list.id), orgHasFeature(orgId, "price_lists")]);
  const products = await listPricingProducts(orgId, lines.map((line) => line.productId));
  const byId = new Map(products.map((product) => [product.id, product]));
  const today = zoneDate(new Date(), org.timeZone);

  return (
    <div className="space-y-5">
      <div>
        <Link href={priceListsPath(orgId)} className="mb-2 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink">
          <BackIcon className="size-4" />
          כל המחירונים
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 className="min-w-0 text-xl font-semibold break-words">{list.name}</h2>
          {editable ? <DeletePriceList orgId={orgId} listId={list.id} name={list.name} /> : null}
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-md text-ink-soft">
          <PriceListStatusBadge list={list} today={today} />
          <span>{validityText(list)}</span>
        </p>
      </div>

      <Card aria-labelledby="price-list-lines-title">
        <CardHeader id="price-list-lines-title" title={`מחירים במחירון (${lines.length})`} />
        {lines.length > 0 ? (
          <PriceListLines orgId={orgId} listId={list.id} lines={lines} products={byId} editable={editable} />
        ) : (
          <CardBody>
            <p className="text-md text-ink-soft">עוד אין מחירים במחירון הזה. כל המוצרים נמכרים בו במחיר שבמוצר.</p>
          </CardBody>
        )}
        {!inPlan ? (
          <CardBody className="border-t border-line">
            <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
              {PRICE_LISTS_NOT_IN_PLAN}
            </p>
          </CardBody>
        ) : editable ? (
          <CardBody className="border-t border-line">
            <h3 className="mb-3 text-md font-semibold">הוספת מחיר</h3>
            <PriceListLineForm orgId={orgId} listId={list.id} products={products.filter(isOfferable)} />
          </CardBody>
        ) : null}
      </Card>

      {editable ? (
        <Card aria-labelledby="price-list-edit-title">
          <CardHeader id="price-list-edit-title" title="פרטי המחירון" />
          <CardBody>
            <PriceListForm orgId={orgId} list={list} timeZone={org.timeZone} />
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
