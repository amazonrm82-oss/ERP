import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { CampaignCostActions, NewCampaignCostForm } from "@/features/campaign-costs/components/campaign-cost-forms";
import { listCampaignCosts, recentCampaignNames } from "@/features/campaign-costs/queries";
import { monthLabel } from "@/features/campaign-costs/schema";
import { canViewCosts } from "@/features/permissions/keys";
import { getMyPermissions } from "@/features/permissions/queries";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { getTaxSettings } from "@/features/tax/queries";
import { chargesVat } from "@/features/tax/status";
import { getOrgTerms } from "@/features/terminology/queries";
import { must } from "@/lib/db-read";
import { formatMoney, zoneDate } from "@/lib/format";
import { paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "עלויות קמפיינים" };

type Props = { params: Promise<{ orgId: string }> };

/** The first day of the month `back` months before the given one ("2026-11-02", 12 -> "2025-11-01"). */
function monthsBack(today: string, back: number): string {
  const [year, month] = today.split("-").map(Number);
  const index = year * 12 + (month - 1) - back;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`;
}

// SEG-03: the costs a business enters by hand, by month and by source or campaign, for the report "עלות קמפיינים והחזר
// השקעה". Everyone in the business reads them; owners, admins and managers enter them.
export default async function CampaignCostsPage({ params }: Props) {
  const { orgId } = await params;
  const context = await getOrgContext(orgId);
  // owner (61) ב: the plan key campaign_costs (the database refuses a cost without it too)
  if (!(await orgHasFeature(orgId, "campaign_costs"))) {
    notFound();
  }
  // owner (65) ד: the rule of product costs: owners, admins and managers by role, or the PRM-01 grant view_costs
  if (!canViewCosts(context.role, await getMyPermissions(orgId))) {
    return (
      <>
        <PageHeader title="עלויות קמפיינים" back={{ href: paths.report(orgId, "campaign_roi"), label: "לדוח" }} />
        <p className="text-md text-ink-soft">את עלויות הקמפיינים רואים ומזינים בעלים, מנהלי מערכת, מנהלים ומי שקיבל הרשאה לראות עלויות.</p>
      </>
    );
  }
  const today = zoneDate(new Date(), context.org.timeZone);
  const since = monthsBack(today, 24);
  const supabase = await createClient();
  const [costs, campaigns, sourceRows, terms] = await Promise.all([
    listCampaignCosts(orgId, since),
    recentCampaignNames(orgId),
    supabase
      .from("lead_sources")
      .select("id, name, is_active")
      .eq("organization_id", orgId)
      .order("name")
      .then((res) => must(res, "lead sources")),
    getOrgTerms(orgId),
  ]);
  // owner (63) ב: "כולל מע"מ" only in a business that charges VAT
  const tax = await getTaxSettings(orgId);
  const showVat = chargesVat(tax.vatStatus, tax.otherChargesVat) === true;
  const sourceName = new Map(sourceRows.map((s) => [s.id, s.name]));
  // the form offers active sources, and any source a listed cost still names
  const used = new Set(costs.map((c) => c.sourceId));
  const sources = sourceRows.filter((s) => s.is_active || used.has(s.id)).map((s) => ({ id: s.id, name: s.name }));
  const writer = context.canWrite;
  const thisMonth = today.slice(0, 7);
  const byMonth = new Map<string, typeof costs>();
  for (const cost of costs) byMonth.set(cost.month, [...(byMonth.get(cost.month) ?? []), cost]);

  return (
    <>
      <PageHeader
        title="עלויות קמפיינים"
        description={`כמה הוצאתם על כל מקור וקמפיין בכל חודש. הדוח משווה את העלות ל${terms.lead.plural} ולהכנסה שהגיעו מהם.`}
        back={{ href: paths.report(orgId, "campaign_roi"), label: "לדוח" }}
      />
      <div className="space-y-5">
        {writer ? (
          <Card aria-labelledby="new-cost">
            <CardHeader id="new-cost" title="עלות חדשה" />
            <CardBody>
              <NewCampaignCostForm orgId={orgId} sources={sources} campaigns={campaigns} month={thisMonth} showVat={showVat} />
            </CardBody>
          </Card>
        ) : (
          <p className="text-md text-ink-soft">העסק במצב קריאה בלבד, ולכן אי אפשר להוסיף עלויות.</p>
        )}
        {costs.length === 0 ? (
          <Card>
            <CardBody>
              <p className="text-md text-ink-soft">עוד לא הוזנו עלויות ב-24 החודשים האחרונים.</p>
            </CardBody>
          </Card>
        ) : (
          [...byMonth.entries()].map(([month, rows]) => {
            const titleId = `costs-${month}`;
            const total = rows.reduce((sum, row) => sum + row.amount, 0);
            return (
              <Card key={month} aria-labelledby={titleId}>
                <CardHeader id={titleId} title={`${monthLabel(month)} · ${formatMoney(total)}`} />
                <ul className="divide-y divide-line">
                  {rows.map((cost) => (
                    <li key={cost.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-3 sm:px-5">
                      <div className="min-w-0">
                        <p className="font-medium text-ink">
                          {[cost.sourceId ? (sourceName.get(cost.sourceId) ?? "מקור") : null, cost.campaign].filter(Boolean).join(" · ") || "ללא מקור"}
                        </p>
                        <p className="text-sm text-ink-soft">
                          {formatMoney(cost.amount)}
                          {cost.includesVat ? ' כולל מע"מ' : ""}
                          {cost.note ? ` · ${cost.note}` : ""}
                        </p>
                      </div>
                      {writer ? (
                        <CampaignCostActions
                          orgId={orgId}
                          sources={sources}
                          campaigns={campaigns}
                          showVat={showVat}
                          cost={{ ...cost, amountText: String(cost.amount / 100) }}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })
        )}
        <p className="text-sm text-ink-soft">
          הסכומים בדוח לפני מע&quot;מ. מוצגים 24 החודשים האחרונים.{" "}
          <Link href={paths.report(orgId, "campaign_roi")} className="font-medium text-accent underline underline-offset-4 hover:text-accent-strong">
            לדוח עלות קמפיינים והחזר השקעה
          </Link>
        </p>
      </div>
    </>
  );
}
