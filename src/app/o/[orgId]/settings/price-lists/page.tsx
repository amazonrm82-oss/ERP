import type { Metadata } from "next";
import Link from "next/link";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ForwardIcon } from "@/components/ui/icons";
import { PriceListForm } from "@/features/price-lists/components/price-list-form";
import { PriceListStatusBadge } from "@/features/price-lists/components/price-list-status";
import { priceListPath } from "@/features/price-lists/paths";
import { listPriceLists } from "@/features/price-lists/queries";
import { validityText } from "@/features/price-lists/status";
import { productsPath } from "@/features/products/paths";
import { PRICE_LISTS_NOT_IN_PLAN } from "@/features/price-lists/schema";
import { isAdminRole } from "@/features/settings/permissions";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { getPricesIncludeVat } from "@/features/tax/queries";
import { zoneDate } from "@/lib/format";

export const metadata: Metadata = { title: "מחירונים" };

type Props = { params: Promise<{ orgId: string }> };

/** PL-01: the business's further price lists. Everyone reads them; owners and admins create, edit and remove. */
export default async function PriceListsPage({ params }: Props) {
  const { orgId } = await params;
  const { org, role, canWrite } = await getOrgContext(orgId);
  const timeZone = org.timeZone;
  const editable = isAdminRole(role) && canWrite;
  const [lists, inPlan, businessIncludesVat] = await Promise.all([
    listPriceLists(orgId),
    orgHasFeature(orgId, "price_lists"),
    getPricesIncludeVat(orgId),
  ]);
  const today = zoneDate(new Date(), timeZone);

  return (
    <div className="space-y-6">
      <Card aria-labelledby="price-lists-title">
        <CardHeader id="price-lists-title" title="המחירונים של העסק" />
        <CardBody className="space-y-2 pb-0 text-md text-ink-soft">
          <p>
            מחירון ברירת המחדל הוא המחיר שבכל מוצר ב
            <Link href={productsPath(orgId)} className="font-medium text-accent-strong underline-offset-2 hover:underline">
              קטלוג
            </Link>
            . מחירון נוסף קובע לחלק מהמוצרים מחיר אחר, או הנחה באחוזים, ואפשר לתת בו מחיר נמוך יותר מכמות מסוימת.
          </p>
          <p>מוצר שאין לו שורה במחירון נמכר במחיר שלו. מחירון לא פעיל, או מחוץ לתאריכים שלו, לא משמש לחישוב.</p>
        </CardBody>
        {lists.length > 0 ? (
          <ul className="mt-3 border-t border-line">
            {lists.map((list) => (
              <li key={list.id} className="border-b border-line last:border-b-0">
                <Link href={priceListPath(orgId, list.id)} className="flex min-h-14 items-center gap-3 px-4 py-3 hover:bg-canvas sm:px-5">
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium break-words text-ink">{list.name}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-soft">
                      <PriceListStatusBadge list={list} today={today} />
                      <span>{validityText(list)}</span>
                      <span>· {list.pricesIncludeVat ? 'כולל מע"מ' : 'לפני מע"מ'}</span>
                    </span>
                  </span>
                  <ForwardIcon className="size-4 shrink-0 text-ink-soft" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <CardBody className="mt-3 border-t border-line">
            <p className="text-md text-ink-soft">אין מחירונים נוספים. כל המוצרים נמכרים במחיר שבקטלוג.</p>
          </CardBody>
        )}
      </Card>

      {!inPlan ? (
        <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
          {PRICE_LISTS_NOT_IN_PLAN}
        </p>
      ) : editable ? (
        <Card aria-labelledby="price-list-new-title">
          <CardHeader id="price-list-new-title" title="מחירון חדש" />
          <CardBody>
            <PriceListForm orgId={orgId} list={null} timeZone={timeZone} businessIncludesVat={businessIncludesVat} locked={false} />
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
