import Link from "next/link";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { cleanupReasons, type CleanupDeal } from "@/features/pipeline-cleanup/rules";
import { formatDate, formatMoney, formatNumber } from "@/lib/format";
import { paths } from "@/lib/paths";

import { dealGroup, MONEY_GROUPS, MONEY_PART_LABELS, type MoneyGroup, type MoneyGroupKey } from "../groups";
import type { MoneyLead, MoneyWaiting } from "../queries";

// rows shown per group; the rest are on the full lists (the cleanup, the waiting leads)
export const ROWS_SHOWN = 50;

type Props = {
  orgId: string;
  money: MoneyWaiting;
  // the tab the screen is on; the link to the cleanup keeps it
  owner: "me" | "all";
  // MNY-02: the one action of a row (null: nothing the user can do there)
  dealAction?: (deal: CleanupDeal) => ReactNode;
  leadAction?: (lead: MoneyLead) => ReactNode;
};

/** MNY-01: the main number, its parts, and one card per group that exists today. */
export function MoneyView({ orgId, money, owner, dealAction, leadAction }: Props) {
  const { summary } = money;
  const dealsOf = (key: MoneyGroupKey) => money.deals.filter((deal) => dealGroup(deal) === key);

  return (
    <>
      <section aria-labelledby="money-total-title" className="mb-5 rounded-lg border border-line bg-surface p-4 sm:p-5">
        <h2 id="money-total-title" className="text-md text-ink-soft">
          כמה כסף מחכה לכם
        </h2>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{formatMoney(summary.total)}</p>
        <ul className="mt-2 space-y-0.5 text-sm text-ink-soft">
          {summary.parts.map((part) => (
            <li key={part.part}>
              {MONEY_PART_LABELS[part.part]}: <span className="tabular-nums">{formatMoney(part.amount)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 border-t border-line pt-3 text-sm">
          <span className="font-medium">{MONEY_PART_LABELS.estimate}, לא נכללת בסכום: </span>
          {summary.estimate.leads === 0 ? (
            "אין לידים שמחכים למענה."
          ) : summary.estimate.amount === null ? (
            `${formatNumber(summary.estimate.leads)} לידים שלא טופלו. כדי להעריך את שווים צריך לפחות ${formatNumber(summary.estimate.minDeals)} עסקאות שנסגרו בהצלחה ב-${formatNumber(summary.estimate.days)} הימים האחרונים.`
          ) : (
            <>
              <span className="tabular-nums">{formatMoney(summary.estimate.amount)}</span> ב-{formatNumber(summary.estimate.leads)} לידים שלא טופלו, לפי ערך ממוצע של
              העסקאות שזכיתם בהן ב-{formatNumber(summary.estimate.days)} הימים האחרונים ואתם רואים (<span className="tabular-nums">{formatMoney(summary.estimate.average)}</span>{" "}
              לעסקה).
            </>
          )}
        </p>
      </section>

      <div className="grid items-start gap-5 lg:grid-cols-2">
        {MONEY_GROUPS.map((group) =>
          group.key === "unhandled_leads" ? (
            <LeadsCard key={group.key} orgId={orgId} group={group} leads={money.leads} count={summary.groups.unhandled_leads.count} average={summary.estimate.average} action={leadAction} />
          ) : (
            <DealsCard key={group.key} orgId={orgId} owner={owner} group={group} deals={dealsOf(group.key)} count={summary.groups[group.key].count} amount={summary.groups[group.key].amount ?? 0} action={dealAction} />
          ),
        )}
      </div>
    </>
  );
}

function GroupHeader({ group, count, amount }: { group: MoneyGroup; count: number; amount: string | null }) {
  return (
    <div className="border-b border-line px-4 pb-3 sm:px-5">
      <p className="text-sm text-ink-soft">{group.description}</p>
      <p className="mt-1 text-md">
        <span className="font-semibold tabular-nums">{formatNumber(count)}</span>
        {amount ? (
          <>
            {" · "}
            <span className="font-semibold tabular-nums">{amount}</span>
          </>
        ) : null}
      </p>
    </div>
  );
}

function DealsCard({
  orgId,
  owner,
  group,
  deals,
  count,
  amount,
  action,
}: {
  orgId: string;
  owner: "me" | "all";
  group: MoneyGroup;
  deals: CleanupDeal[];
  count: number;
  amount: number;
  action?: (deal: CleanupDeal) => ReactNode;
}) {
  const shown = deals.slice(0, ROWS_SHOWN);
  return (
    <Card aria-labelledby={`money-${group.key}-title`}>
      <CardHeader id={`money-${group.key}-title`} title={group.title} />
      <GroupHeader group={group} count={count} amount={formatMoney(amount)} />
      {shown.length === 0 ? (
        <p className="px-4 py-4 text-md text-ink-soft sm:px-5">אין עסקאות כאלה כרגע.</p>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((deal) => (
            <li key={deal.id} className="px-4 py-3 sm:px-5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <Link href={paths.deal(orgId, deal.id)} className="min-w-0 break-words font-medium underline-offset-4 hover:underline">
                  {deal.name || "עסקה ללא שם"}
                </Link>
                <span className="text-sm font-medium tabular-nums">{formatMoney(deal.amount)}</span>
              </div>
              <p className="mt-0.5 text-sm text-ink-soft">
                {deal.ownerName ? <bdi>{deal.ownerName}</bdi> : "בלי אחראי"}
                {deal.stageName ? ` · ${deal.stageName}` : ""}
              </p>
              <p className="mt-0.5 text-sm text-ink-soft">{cleanupReasons(deal, formatNumber).join(" · ")}</p>
              {action ? action(deal) : null}
            </li>
          ))}
        </ul>
      )}
      {count > shown.length ? (
        <p className="border-t border-line px-4 py-2.5 text-sm sm:px-5">
          <Link href={paths.dealsCleanup(orgId, owner)} className="text-accent-strong underline underline-offset-4">
            לכל {formatNumber(count)} העסקאות בניקוי השבועי
          </Link>
        </p>
      ) : null}
    </Card>
  );
}

function LeadsCard({
  orgId,
  group,
  leads,
  count,
  average,
  action,
}: {
  orgId: string;
  group: MoneyGroup;
  leads: MoneyLead[];
  count: number;
  average: number | null;
  action?: (lead: MoneyLead) => ReactNode;
}) {
  const shown = leads.slice(0, ROWS_SHOWN);
  return (
    <Card aria-labelledby={`money-${group.key}-title`}>
      <CardHeader id={`money-${group.key}-title`} title={group.title} action={<Badge>{MONEY_PART_LABELS.estimate}</Badge>} />
      <GroupHeader group={group} count={count} amount={average === null ? null : `${formatMoney(average * count)} (הערכה)`} />
      {shown.length === 0 ? (
        <p className="px-4 py-4 text-md text-ink-soft sm:px-5">כל הלידים קיבלו מענה.</p>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((lead) => (
            <li key={lead.id} className="px-4 py-3 sm:px-5">
              <Link href={paths.lead(orgId, lead.id)} className="block min-w-0 break-words font-medium underline-offset-4 hover:underline">
                {lead.name}
              </Link>
              <p className="mt-0.5 text-sm text-ink-soft">
                {lead.ownerName ? <bdi>{lead.ownerName}</bdi> : "בלי אחראי"} · נוצר ב-<time dateTime={lead.createdAt}>{formatDate(lead.createdAt)}</time>
              </p>
              {action ? action(lead) : null}
            </li>
          ))}
        </ul>
      )}
      {count > shown.length ? (
        <p className="border-t border-line px-4 py-2.5 text-sm sm:px-5">
          <Link href={paths.leadsWaiting(orgId)} className="text-accent-strong underline underline-offset-4">
            לכל הלידים שעוד לא קיבלו מענה
          </Link>
        </p>
      ) : null}
    </Card>
  );
}
