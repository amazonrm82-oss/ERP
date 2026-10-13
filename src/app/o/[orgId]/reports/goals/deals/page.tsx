import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { GOAL_PERIODS, periodStartOf, type GoalPeriod } from "@/features/goals/metrics";
import { countsDeals, periodLabel } from "@/features/goals/progress";
import { getGoalProgress, listGoalDeals } from "@/features/goals/progress-queries";
import { getOrgContext, getUserNames } from "@/features/shell/queries";
import { isCalendarDate } from "@/lib/calendar-date";
import { must } from "@/lib/db-read";
import { formatDate, formatMoney, formatNumber } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";
import { firstParam } from "@/lib/search";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "עסקאות ביעד" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * GOL-03 (owner, 13 October 2026, option A): the won deals a team goal counts, by the team set on
 * the deal (the team and the teams below it), or with team=none the won deals with no team. One goal
 * period, read with the user's session: a manager of the team sees exactly what the goal counts.
 */
export default async function GoalDealsPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const query = await searchParams;
  const team = firstParam(query.team);
  const period = firstParam(query.period);
  const start = firstParam(query.start);
  if (
    !(team === "none" || isUuid(team)) ||
    !(GOAL_PERIODS as readonly string[]).includes(period) ||
    !isCalendarDate(start) ||
    periodStartOf(period as GoalPeriod, start) !== start
  ) {
    notFound();
  }
  const goalPeriod = period as GoalPeriod;
  const context = await getOrgContext(orgId);
  // who may see the list: team=none, owners, admins and a support session; a team, whoever sees that team's deal goal in this
  // period (the same rule as report_goal_progress, asked of it rather than repeated)
  const allowed =
    team === "none"
      ? // owners, admins and platform support in an open session (not a member), as in the report
        context.role === "owner" || context.role === "admin" || context.supportUntil !== null
      : // a team goal on deals: a team with only a leads or meetings goal has no deals list
        (await getGoalProgress(orgId, { period: { period: goalPeriod, periodStart: start } })).some(
          (g) => g.scope === "team" && g.subjectId === team && countsDeals(g.metric),
        );
  if (!allowed) {
    return (
      <>
        <PageHeader title="עסקאות ביעד" back={{ href: paths.reports(orgId), label: "דוחות" }} />
        <p className="text-md">אין לך גישה לרשימה הזו</p>
      </>
    );
  }
  const supabase = await createClient();
  const [deals, teamRows] = await Promise.all([
    listGoalDeals(orgId, team, goalPeriod, start, context.org.timeZone),
    team === "none" ? Promise.resolve(null) : supabase.from("teams").select("name").eq("organization_id", orgId).eq("id", team),
  ]);
  const teamName = teamRows ? (must(teamRows, "teams") ?? [])[0]?.name : null;
  if (team !== "none" && !teamName) {
    notFound();
  }
  const names = await getUserNames(deals.map((d) => d.ownerId));
  const total = deals.reduce((sum, d) => sum + d.amount, 0);
  const title = team === "none" ? "עסקאות שנסגרו בלי צוות" : `עסקאות שנסגרו בצוות ${teamName}`;

  return (
    <>
      <PageHeader
        title={title}
        description={`${periodLabel(goalPeriod, start)}. ${
          team === "none" ? "עסקאות שנסגרו בהצלחה ולא משויכות לאף צוות, ולכן לא נספרות ביעד של צוות." : "כולל הצוותים שמתחת לצוות. כך נספר היעד של הצוות."
        }`}
        back={{ href: paths.reports(orgId), label: "דוחות" }}
      />
      <p className="mb-4 text-md">
        {formatNumber(deals.length)} עסקאות, סך הכול <span className="font-semibold tabular-nums">{formatMoney(total)}</span>
      </p>
      <Card aria-label={title}>
        {deals.length === 0 ? (
          <p className="px-4 py-6 text-md text-ink-soft sm:px-5">אין עסקאות כאלה בתקופה הזו.</p>
        ) : (
          <ul className="divide-y divide-line">
            {deals.map((deal) => (
              <li key={deal.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 py-3 sm:px-5">
                <span className="min-w-0">
                  <Link href={paths.deal(orgId, deal.id)} className="break-words font-medium underline-offset-4 hover:underline">
                    {deal.name}
                  </Link>
                  <span className="block text-sm text-ink-soft">
                    <bdi>{deal.ownerId ? (names.get(deal.ownerId) ?? "משתמש") : "ללא אחראי"}</bdi> · נסגרה ב-
                    <time dateTime={deal.closedAt}>{formatDate(deal.closedAt)}</time>
                  </span>
                </span>
                <span className="tabular-nums">{formatMoney(deal.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
