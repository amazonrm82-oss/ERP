// GOL-02: the goals screen's grid (people, teams and the business against months), as plain
// functions the page, the actions and the unit tests share.

import { addMonths, GOAL_METRIC_KEYS, GOAL_PERIODS, type GoalMetric, type GoalPeriod, type GoalScope } from "./metrics";

export type GoalColumn = { start: string; label: string; short: string };

export type GoalRowKind = { scope: GoalScope; subjectId: string | null };

export type GoalGridRow = GoalRowKind & { key: string; label: string; hint?: string };

export type GoalValue = GoalRowKind & { periodStart: string; target: number };

export const YEAR_MIN = 2000;
export const YEAR_MAX = 2100;

const monthLong = new Intl.DateTimeFormat("he-IL", { month: "long", timeZone: "UTC" });
const monthShort = new Intl.DateTimeFormat("he-IL", { month: "short", timeZone: "UTC" });

const pad = (n: number) => String(n).padStart(2, "0");

/** The columns of one year: 12 months, 4 quarters or the year itself. */
export function goalColumns(period: GoalPeriod, year: number): GoalColumn[] {
  if (period === "year") {
    return [{ start: `${year}-01-01`, label: String(year), short: String(year) }];
  }
  if (period === "quarter") {
    return [1, 2, 3, 4].map((q) => ({ start: `${year}-${pad((q - 1) * 3 + 1)}-01`, label: `רבעון ${q}`, short: `ר${q}` }));
  }
  return Array.from({ length: 12 }, (_, i) => {
    const date = new Date(Date.UTC(year, i, 15));
    return { start: `${year}-${pad(i + 1)}-01`, label: monthLong.format(date), short: monthShort.format(date) };
  });
}

/** The start of the period before `start` (the month, quarter or year before). */
export function previousStart(period: GoalPeriod, start: string): string {
  const month = start.slice(0, 7);
  const back = period === "year" ? 12 : period === "quarter" ? 3 : 1;
  return `${addMonths(month, -back)}-01`;
}

/** The column the copy button fills by default: the current period when it is on screen, else the first. */
export function defaultCopyTarget(columns: GoalColumn[], period: GoalPeriod, today: string): string {
  const [year, month] = today.split("-").map(Number);
  const current =
    period === "year" ? `${year}-01-01` : period === "quarter" ? `${year}-${pad(Math.floor((month - 1) / 3) * 3 + 1)}-01` : `${year}-${pad(month)}-01`;
  return columns.some((c) => c.start === current) ? current : columns[0].start;
}

export function rowKey(row: GoalRowKind): string {
  return `${row.scope}:${row.subjectId ?? "-"}`;
}

export function cellKey(row: GoalRowKind, periodStart: string): string {
  return `${rowKey(row)}@${periodStart}`;
}

/** Saved targets by cell. */
export function valuesByCell(values: GoalValue[]): Record<string, number> {
  return Object.fromEntries(values.map((v) => [cellKey(v, v.periodStart), v.target]));
}

/**
 * What "copy from the previous period" adds: every goal of the previous period whose row is
 * still on the grid and has no goal in the target period yet. Existing goals are never
 * overwritten.
 */
export function copyPlan(previous: GoalValue[], existing: GoalValue[], rows: GoalRowKind[], targetStart: string): GoalValue[] {
  const onGrid = new Set(rows.map(rowKey));
  const taken = new Set(existing.filter((v) => v.periodStart === targetStart).map(rowKey));
  return previous
    .filter((v) => onGrid.has(rowKey(v)) && !taken.has(rowKey(v)))
    .map((v) => ({ scope: v.scope, subjectId: v.subjectId, periodStart: targetStart, target: v.target }));
}

/** Sum of the people's targets per column (a team or business goal is not a sum of people). */
export function peopleTotals(values: GoalValue[], columns: GoalColumn[]): Record<string, number | null> {
  return Object.fromEntries(
    columns.map((c) => {
      const cells = values.filter((v) => v.scope === "user" && v.periodStart === c.start);
      return [c.start, cells.length ? cells.reduce((s, v) => s + v.target, 0) : null];
    }),
  );
}

export type GoalView = { metric: GoalMetric; period: GoalPeriod; year: number };

/** The screen's choices from the query string; anything unknown falls back to this month's revenue. */
export function goalView(
  params: { metric?: string; period?: string; year?: string },
  today: string,
  metrics: readonly GoalMetric[] = GOAL_METRIC_KEYS,
): GoalView {
  const metric = (metrics as readonly string[]).includes(params.metric ?? "") ? (params.metric as GoalMetric) : "won_amount";
  const period = (GOAL_PERIODS as readonly string[]).includes(params.period ?? "") ? (params.period as GoalPeriod) : "month";
  const parsed = Number(params.year);
  const year = Number.isInteger(parsed) && parsed >= YEAR_MIN && parsed <= YEAR_MAX ? parsed : Number(today.slice(0, 4));
  return { metric, period, year };
}

export type TeamLink = { id: string; parent_team_id: string | null };
export type TeamMemberLink = { team_id: string; user_id: string; is_manager: boolean };

/** Teams the user manages, with every team below them (the rule of app.manages_team, 10 levels). */
export function managedTeams(userId: string, teams: TeamLink[], members: TeamMemberLink[]): Set<string> {
  const managed = new Set(members.filter((m) => m.user_id === userId && m.is_manager).map((m) => m.team_id));
  const parentOf = new Map(teams.map((t) => [t.id, t.parent_team_id]));
  const result = new Set<string>();
  for (const team of teams) {
    let at: string | null | undefined = team.id;
    for (let depth = 0; at && depth < 10; depth++) {
      if (managed.has(at)) {
        result.add(team.id);
        break;
      }
      at = parentOf.get(at);
    }
  }
  return result;
}
