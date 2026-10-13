import type { Metadata } from "next";

import { PageHeader } from "@/components/ui/page-header";
import { GoalsFilters } from "@/features/goals/components/goals-filters";
import { GoalsPanel } from "@/features/goals/components/goals-panel";
import { defaultCopyTarget, goalColumns, goalView, previousStart, type GoalValue } from "@/features/goals/grid";
import { goalMetric, GOAL_PERIOD_LABELS } from "@/features/goals/metrics";
import { getGoalsGrid } from "@/features/goals/queries";
import { getOrgContext } from "@/features/shell/queries";
import { zoneDate } from "@/lib/format";
import { paths } from "@/lib/paths";
import { firstParam } from "@/lib/search";

export const metadata: Metadata = { title: "יעדים" };

/** What the person can do here, in one line. */
function accessNote(role: string, canWrite: boolean, anyEditable: boolean): string {
  if (!canWrite && (role === "owner" || role === "admin" || role === "manager")) return "העסק במצב קריאה בלבד, ולכן אי אפשר לשנות יעדים.";
  if (role === "owner" || role === "admin") return "הקלידו יעד בתא. תא ריק הוא בלי יעד.";
  if (role === "manager") {
    return anyEditable
      ? "אפשר לקבוע יעדים לצוותים שאתם מנהלים ולנציגים בהם. את שאר היעדים, כולל של מנהלים, קובעים בעלי העסק ומנהלי המערכת."
      : "אתם לא מנהלים צוות כרגע, ולכן היעדים כאן לצפייה. בעלי העסק ומנהלי המערכת קובעים אותם.";
  }
  return "בעלי העסק, מנהלי המערכת ומנהלי הצוותים קובעים את היעדים. כאן מוצגים היעדים שלכם, של הצוות שלכם ושל כל העסק.";
}

/** Changes when the view or the saved goals change (after a copy), so the grid starts over from them. */
function gridKey(view: { metric: string; period: string; year: number }, values: GoalValue[]): string {
  let hash = 5381;
  for (const v of values) {
    for (const ch of `${v.scope}${v.subjectId}${v.periodStart}${v.target};`) hash = ((hash * 33) ^ ch.charCodeAt(0)) >>> 0;
  }
  return `${view.metric}:${view.period}:${view.year}:${values.length}:${hash}`;
}

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// GOL-02: goals of people, teams and the business against months (or quarters, or years).
export default async function GoalsPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const query = await searchParams;
  const context = await getOrgContext(orgId);
  const today = zoneDate(new Date(), context.org.timeZone);
  const view = goalView({ metric: firstParam(query.metric), period: firstParam(query.period), year: firstParam(query.year) }, today);
  const grid = await getGoalsGrid(context, view);
  const definition = goalMetric(view.metric);

  // the period before each column, named the way its own column would be
  const previousLabels = Object.fromEntries(
    grid.columns.map((c) => {
      const before = previousStart(view.period, c.start);
      const label = goalColumns(view.period, Number(before.slice(0, 4))).find((p) => p.start === before)?.label ?? before;
      const sameYear = before.slice(0, 4) === c.start.slice(0, 4) || view.period === "year";
      return [c.start, sameYear ? label : `${label} ${before.slice(0, 4)}`];
    }),
  );
  const thisYear = Number(today.slice(0, 4));
  const years = [...new Set([thisYear - 1, thisYear, thisYear + 1, view.year])].sort((a, b) => a - b);

  return (
    <>
      <PageHeader
        title="יעדים"
        description={`${definition.label} לפי ${GOAL_PERIOD_LABELS[view.period]}, ${view.year}. ${definition.description}`}
        back={{ href: paths.reports(orgId), label: "דוחות" }}
      />
      <GoalsFilters metric={view.metric} period={view.period} year={view.year} years={years} />
      <p className="mb-4 text-md text-ink-soft">{accessNote(context.role, context.canWrite, grid.editable.length > 0)}</p>
      <GoalsPanel
        gridKey={gridKey(view, grid.values)}
        orgId={orgId}
        metric={view.metric}
        period={view.period}
        columns={grid.columns}
        rows={grid.rows}
        values={grid.values}
        editable={grid.editable}
        copyTarget={defaultCopyTarget(grid.columns, view.period, today)}
        previousLabels={previousLabels}
      />
    </>
  );
}
