import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { BackIcon } from "@/components/ui/icons";
import { DeletePriceList } from "@/features/price-lists/components/delete-price-list";
import { PriceListForm } from "@/features/price-lists/components/price-list-form";
import { PriceListStatusBadge } from "@/features/price-lists/components/price-list-status";
import { priceListsPath } from "@/features/price-lists/paths";
import { getPriceList } from "@/features/price-lists/queries";
import { validityText } from "@/features/price-lists/status";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { zoneDate } from "@/lib/format";
import { isUuid } from "@/lib/paths";

export const metadata: Metadata = { title: "מחירון" };

type Props = { params: Promise<{ orgId: string; listId: string }> };

/** PL-01: one price list. Everyone reads it; owners and admins of a writable organization edit and remove it. */
export default async function PriceListPage({ params }: Props) {
  const { orgId, listId } = await params;
  const { org, role, canWrite } = await getOrgContext(orgId);
  if (!isUuid(listId)) notFound();
  const list = await getPriceList(orgId, listId);
  if (!list) notFound();
  const editable = isAdminRole(role) && canWrite;
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
