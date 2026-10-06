import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { formatMoney } from "@/lib/format";
import { paths } from "@/lib/paths";

import { DEAL_STATUS } from "../display";
import type { RelatedDeal } from "../queries";

type Props = {
  orgId: string;
  deals: RelatedDeal[];
  // "?contact=<id>" or "?company=<id>": preselects the record in the new-deal form
  newDealQuery: string | null;
  emptyText: string;
};

/** Deals of a contact or a company, on its card. */
export function RelatedDealsCard({ orgId, deals, newDealQuery, emptyText }: Props) {
  return (
    <Card aria-labelledby="related-deals-title">
      <CardHeader
        id="related-deals-title"
        title="עסקאות"
        action={
          newDealQuery ? (
            <ButtonLink href={`${paths.dealNew(orgId)}${newDealQuery}`} variant="ghost" size="sm">
              עסקה חדשה
            </ButtonLink>
          ) : null
        }
      />
      <CardBody>
        {deals.length === 0 ? (
          <p className="text-[0.9375rem] text-ink-soft">{emptyText}</p>
        ) : (
          <ul className="divide-y divide-line">
            {deals.map((deal) => (
              <li key={deal.id} className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                <span className="min-w-0">
                  <Link href={paths.deal(orgId, deal.id)} className="block break-words font-medium underline-offset-4 hover:underline">
                    {deal.name}
                  </Link>
                  <span className="block text-sm text-ink-soft">
                    {formatMoney(deal.amountAgorot)}
                    {deal.stageName ? `, ${deal.stageName}` : ""}
                  </span>
                </span>
                <Badge tone={DEAL_STATUS[deal.status].tone}>{DEAL_STATUS[deal.status].label}</Badge>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
