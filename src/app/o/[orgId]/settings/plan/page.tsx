import type { Metadata } from "next";

import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { PlanCards } from "@/features/plans/components/plan-cards";
import { listPlanCards } from "@/features/plans/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getPlanUsage } from "@/features/settings/plan-usage";
import { getOrgContext } from "@/features/shell/queries";
import { SupportContact } from "@/features/support/components/support-contact";
import { cn } from "@/lib/cn";
import { daysUntil, formatDate, formatNumber } from "@/lib/format";

export const metadata: Metadata = { title: "חבילה ושימוש" };

type Props = { params: Promise<{ orgId: string }> };

const STATUS: Record<string, string> = {
  trialing: "תקופת ניסיון",
  active: "פעילה",
  past_due: "התשלום לא עבר",
  canceled: "בוטלה",
};

// FXU-04: until there is billing, the plan and its usage, read only, with the way to reach us.
export default async function PlanUsagePage({ params }: Props) {
  const { orgId } = await params;
  const { role } = await getOrgContext(orgId);
  if (!isAdminRole(role)) {
    return (
      <Card>
        <EmptyState kind="locked" title="פנו לבעלים של העסק" description="את החבילה ואת השימוש בה רואים הבעלים ומנהלי המערכת של העסק." />
      </Card>
    );
  }
  const plan = await getPlanUsage(orgId);
  if (!plan) {
    return null;
  }
  const trialDays = plan.status === "trialing" ? daysUntil(plan.trialEndsAt) : null;
  const cards = await listPlanCards(orgId, plan.planKey);

  return (
    <div className="space-y-5">
      <Card aria-labelledby="plan-title">
        <CardHeader id="plan-title" title="החבילה" />
        <CardBody className="space-y-2">
          <p className="flex flex-wrap items-center gap-2 text-lead font-semibold">
            {plan.planName}
            <Badge tone={plan.status === "past_due" ? "danger" : plan.status === "trialing" ? "accent" : "success"}>{STATUS[plan.status] ?? plan.status}</Badge>
          </p>
          {trialDays !== null ? (
            <p className="text-md text-ink-soft">
              {trialDays > 0 ? `נשארו ${formatNumber(trialDays)} ימי ניסיון, עד ${formatDate(plan.trialEndsAt)}.` : "תקופת הניסיון הסתיימה."}
            </p>
          ) : null}
          <p className="text-md text-ink-soft">תשלום ושינוי חבילה מתוך המערכת עוד לא זמינים. כדי לשנות חבילה, דברו איתנו:</p>
          <SupportContact />
        </CardBody>
      </Card>

      <Card aria-labelledby="plans-title">
        <CardHeader id="plans-title" title="החבילות" />
        <CardBody>
          <PlanCards orgId={orgId} plans={cards} />
        </CardBody>
      </Card>

      <Card aria-labelledby="usage-title">
        <CardHeader id="usage-title" title="שימוש מול מכסות החבילה" />
        <ul className="divide-y divide-line">
          {plan.usage.map((row) => {
            const share = row.limit ? Math.min(row.used / row.limit, 1) : 0;
            const near = row.limit !== null && share >= 0.8;
            // a number with a Latin unit keeps its order inside the Hebrew line
            const amount = (n: number) => (row.unit ? <bdi dir="ltr">{`${formatNumber(n)} ${row.unit}`}</bdi> : formatNumber(n));
            return (
              <li key={row.key} className="px-4 py-3 sm:px-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{row.label}</span>
                  <span className={cn("text-md tabular-nums", near ? "font-semibold text-danger" : "text-ink-soft")}>
                    {row.limit === null ? (
                      <>
                        {amount(row.used)} · ללא הגבלה
                      </>
                    ) : (
                      <>
                        {amount(row.used)} מתוך {amount(row.limit)}
                      </>
                    )}
                  </span>
                </div>
                {row.limit !== null ? (
                  <div
                    role="meter"
                    aria-label={row.label}
                    aria-valuemin={0}
                    aria-valuemax={row.limit}
                    aria-valuenow={row.used}
                    className="mt-2 h-2 overflow-hidden rounded-full bg-canvas"
                  >
                    <div className={cn("h-full rounded-full", near ? "bg-danger" : "bg-accent")} style={{ width: `${Math.round(share * 100)}%` }} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
