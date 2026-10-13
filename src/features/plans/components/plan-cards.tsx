import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/format";

import { joinPlanWaitlistAction } from "../actions";
import { planCapabilities } from "../capabilities";
import { annualPriceLabel, monthlyPriceLabel, VAT_NOTE } from "../price";
import type { PlanCard } from "../queries";

function limitOf(limits: unknown, key: string): number | null | undefined {
  const all = limits && typeof limits === "object" && !Array.isArray(limits) ? (limits as Record<string, unknown>) : {};
  const value = all[key];
  return typeof value === "number" ? value : value === null ? null : undefined;
}

function quotaLines(limits: unknown): string[] {
  const users = limitOf(limits, "max_users");
  const records = limitOf(limits, "max_records");
  const storage = limitOf(limits, "storage_gb");
  const lines: string[] = [];
  if (users !== undefined) lines.push(users === null ? "משתמשים בלי תקרה" : `עד ${formatNumber(users)} משתמשים`);
  if (records !== undefined) lines.push(records === null ? "רשומות בלי תקרה" : `עד ${formatNumber(records)} רשומות`);
  if (storage !== undefined && storage !== null) lines.push(`אחסון ${formatNumber(storage)} GB`);
  return lines;
}

/**
 * The plans a business can see (owner's pricing, 13 October 2026): price per business
 * or per user, before VAT, and what each includes; a capability not built yet says
 * "בקרוב". A coming-soon plan cannot be chosen; a person may ask to hear when it opens.
 */
export function PlanCards({ orgId, plans }: { orgId: string; plans: PlanCard[] }) {
  return (
    <ul className="grid gap-4 md:grid-cols-2">
      {plans.map((plan) => {
        const titleId = `plan-card-${plan.key}`;
        return (
          <li key={plan.key} aria-labelledby={titleId} className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 id={titleId} className="text-lead font-semibold">
                {plan.name_he}
              </h3>
              {plan.current ? <Badge tone="success">החבילה שלכם</Badge> : null}
              {plan.availability === "coming_soon" ? <Badge tone="accent">בקרוב</Badge> : null}
            </div>
            <div>
              <p className="text-md font-semibold">{monthlyPriceLabel(plan)}</p>
              <p className="text-sm text-ink-soft">
                {annualPriceLabel(plan)}. {VAT_NOTE}.
              </p>
            </div>
            <ul className="space-y-1 text-sm">
              {quotaLines(plan.limits).map((line) => (
                <li key={line}>{line}</li>
              ))}
              {planCapabilities(plan.features).map((item) => (
                <li key={item.feature} className="flex flex-wrap items-center gap-2">
                  {item.label}
                  {item.built ? null : <Badge>בקרוב</Badge>}
                </li>
              ))}
            </ul>
            {plan.availability === "coming_soon" && !plan.current ? (
              <div className="mt-auto">
                {plan.waiting ? (
                  <p className="text-sm text-ink-soft" role="status">
                    נרשמתם. נעדכן כשהחבילה תיפתח.
                  </p>
                ) : (
                  <ActionButton action={joinPlanWaitlistAction.bind(null, orgId, plan.key)} pendingText="נרשמים…" srLabel={plan.name_he}>
                    עדכנו אותי כשזה זמין
                  </ActionButton>
                )}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
