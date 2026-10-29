// GOL-03: progress against a goal, as plain functions the dashboard, "My day", the rep
// performance report and the unit tests share. The numbers come from
// public.report_goal_progress (migration goal_progress); this file only does the arithmetic
// and the words.

import { formatMoney, formatNumber } from "@/lib/format";

import { goalMetric, GOAL_PERIOD_LABELS, type GoalMetric, type GoalPeriod, type GoalScope } from "./metrics";

export type GoalProgress = {
  goalId: string;
  scope: GoalScope;
  // the person or team; null for the business
  subjectId: string | null;
  period: GoalPeriod;
  periodStart: string;
  metric: GoalMetric;
  target: number;
  actual: number;
  // share of the period's time already gone, 0..1, in the organization's time zone
  elapsed: number;
};

export type GoalStanding = "reached" | "on_pace" | "behind";

/**
 * Where a goal stands on one calendar day (the organization's date):
 * - early: less than a quarter of the period's days have passed; no pace yet
 * - pace: from the quarter day on; the linear pace is shown
 * - reached: actual >= target (a positive target); nothing more to say
 * - over: the period has ended (or a past period in a report): the final percent only
 * - upcoming: the period has not started
 * - none: a target of 0, nothing to measure against
 */
export type GoalPhase = "early" | "pace" | "reached" | "over" | "upcoming" | "none";

export type ProgressFigures = {
  phase: GoalPhase;
  // actual / target, whole percent; null for a target of 0
  percent: number | null;
  // linear pace to the end of the period (actual / elapsed), only in the "pace" phase
  projected: number | null;
  projectedPercent: number | null;
  // what is still needed per calendar day, today included (early and pace phases)
  requiredPerDay: number | null;
  // the first day the pace is shown (the quarter day), "YYYY-MM-DD"
  paceFrom: string;
  standing: GoalStanding | null;
};

const DAY = 86_400_000;
const dayNumber = (date: string) => Math.round(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / DAY);
const dateOf = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);

/** The first day after the period ("YYYY-MM-DD"). */
export function periodEnd(period: GoalPeriod, periodStart: string): string {
  const [year, month] = periodStart.split("-").map(Number);
  const months = period === "year" ? 12 : period === "quarter" ? 3 : 1;
  const index = month - 1 + months;
  return `${year + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`;
}

/** The day the pace starts to show: a quarter of the period's calendar days, rounded up, after its start. */
export function paceStartDay(period: GoalPeriod, periodStart: string): string {
  const start = dayNumber(periodStart);
  const days = dayNumber(periodEnd(period, periodStart)) - start;
  return dateOf(start + Math.ceil(days * 0.25));
}

/**
 * Percent, the linear pace and what is needed per day, on `today` (the organization's calendar
 * date). `elapsed` is the share of the period's time gone, from the database.
 * Calendar days for now; working days come with CAP-09.
 */
export function progressFigures(
  goal: { period: GoalPeriod; periodStart: string; target: number; actual: number; elapsed: number },
  today: string,
): ProgressFigures {
  const { period, periodStart, target, actual } = goal;
  const paceFrom = paceStartDay(period, periodStart);
  const empty = { projected: null, projectedPercent: null, requiredPerDay: null, paceFrom };
  if (target <= 0) {
    return { phase: "none", percent: null, standing: null, ...empty };
  }
  const percent = Math.round((actual / target) * 100);
  if (actual >= target) {
    return { phase: "reached", percent, standing: "reached", ...empty };
  }
  const now = dayNumber(today);
  const end = dayNumber(periodEnd(period, periodStart));
  if (now >= end) {
    return { phase: "over", percent, standing: null, ...empty };
  }
  if (now < dayNumber(periodStart)) {
    return { phase: "upcoming", percent, standing: null, ...empty };
  }
  // today included: on the last day one day is left
  const requiredPerDay = (target - actual) / (end - now);
  if (now < dayNumber(paceFrom)) {
    return { phase: "early", percent, standing: null, projected: null, projectedPercent: null, requiredPerDay, paceFrom };
  }
  const share = Math.min(1, Math.max(0, goal.elapsed));
  const projected = share > 0 ? Math.round(actual / share) : null;
  const projectedPercent = projected === null ? null : Math.round((projected / target) * 100);
  return {
    phase: "pace",
    percent,
    standing: projected !== null && projected >= target ? "on_pace" : "behind",
    projected,
    projectedPercent,
    requiredPerDay,
    paceFrom,
  };
}

export const STANDING_LABELS: Record<GoalStanding, { label: string; tone: "success" | "accent" | "warning" }> = {
  reached: { label: "היעד הושג", tone: "success" },
  on_pace: { label: "בקצב ליעד", tone: "accent" },
  behind: { label: "מתחת לקצב", tone: "warning" },
};

const COUNT_UNITS: Record<Exclude<GoalMetric, "won_amount" | "collected">, { one: string; many: string }> = {
  won_deals: { one: "עסקה אחת", many: "עסקאות" },
  leads_handled: { one: "ליד אחד", many: "לידים" },
  meetings_held: { one: "פגישה אחת", many: "פגישות" },
};

const oneDecimal = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 1 });

/**
 * The amount needed per day, rounded up so it is enough: whole shekels for money; for counts one
 * decimal under 10 and a whole number from 10, with the metric's unit ("1.5 עסקאות").
 */
export function requiredPerDayText(metric: GoalMetric, value: number): string {
  if (metric === "won_amount" || metric === "collected") return formatMoney(Math.ceil(value / 100) * 100);
  const rounded = requiredPerDayValue(metric, value);
  const unit = COUNT_UNITS[metric];
  return rounded === 1 ? unit.one : `${oneDecimal.format(rounded)} ${unit.many}`;
}

/** The same rounding as a number (agorot for money), for tables and exports. */
export function requiredPerDayValue(metric: GoalMetric, value: number): number {
  if (metric === "won_amount" || metric === "collected") return Math.ceil(value / 100) * 100;
  return value < 10 ? Math.ceil(Math.round(value * 1000) / 100) / 10 : Math.ceil(value);
}

const calendarDate = new Intl.DateTimeFormat("he-IL", { dateStyle: "medium", timeZone: "UTC" });

/** A calendar date ("YYYY-MM-DD", already the organization's date) as text. */
export function calendarDateText(date: string): string {
  return calendarDate.format(new Date(`${date}T12:00:00Z`));
}

const monthName = new Intl.DateTimeFormat("he-IL", { month: "long", year: "numeric", timeZone: "UTC" });

/** "אוקטובר 2026", "רבעון 4, 2026", "שנת 2026". */
export function periodLabel(period: GoalPeriod, periodStart: string): string {
  const [year, month] = periodStart.split("-").map(Number);
  if (period === "year") return `שנת ${year}`;
  if (period === "quarter") return `רבעון ${Math.floor((month - 1) / 3) + 1}, ${year}`;
  return monthName.format(new Date(Date.UTC(year, month - 1, 15)));
}

/** "לסוף החודש" and the like, for the pace line. */
export function periodEndLabel(period: GoalPeriod): string {
  return `לסוף ה${GOAL_PERIOD_LABELS[period]}`;
}

/** A value of the metric as text: shekels for money, a whole number otherwise. */
export function metricValue(metric: GoalMetric, value: number): string {
  return goalMetric(metric).kind === "money" ? formatMoney(value) : formatNumber(value);
}

/**
 * The goal period a report's dates stand for, when they are exactly one month, quarter or year
 * (calendar dates, both inclusive). Other ranges have no goal to compare with.
 */
export function goalPeriodOf(fromDate: string, toDate: string): { period: GoalPeriod; periodStart: string } | null {
  const from = /^(\d{4})-(\d{2})-01$/.exec(fromDate);
  if (!from) return null;
  const year = Number(from[1]);
  const month = Number(from[2]);
  const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const endOf = (months: number) => {
    const index = month - 1 + months - 1;
    return lastDay(year + Math.floor(index / 12), (index % 12) + 1);
  };
  if (toDate === endOf(1)) return { period: "month", periodStart: fromDate };
  if ((month - 1) % 3 === 0 && toDate === endOf(3)) return { period: "quarter", periodStart: fromDate };
  if (month === 1 && toDate === endOf(12)) return { period: "year", periodStart: fromDate };
  return null;
}

/**
 * The goal period of a report's period choice: "this month" and "this year" run up to today and
 * stand for the whole month or year (the pace says where it is heading); the other choices only
 * when their dates are exactly one month, quarter or year.
 */
export function reportGoalPeriod(key: string, fromDate: string, toDate: string): { period: GoalPeriod; periodStart: string } | null {
  if (key === "this_month") return { period: "month", periodStart: `${fromDate.slice(0, 7)}-01` };
  if (key === "this_year") return { period: "year", periodStart: `${fromDate.slice(0, 4)}-01-01` };
  return goalPeriodOf(fromDate, toDate);
}

/** A team and every team below it, 10 levels deep (the rule of the goal's SQL and app.manages_team). */
export function teamSubtree(rootId: string, teams: Array<{ id: string; parent_team_id: string | null }>): string[] {
  const result = [rootId];
  let level = [rootId];
  for (let depth = 1; depth < 10 && level.length > 0; depth++) {
    level = teams.filter((t) => t.parent_team_id !== null && level.includes(t.parent_team_id) && !result.includes(t.id)).map((t) => t.id);
    result.push(...level);
  }
  return result;
}

/** The won deals a team goal counts ("none": deals with no team), as a link to the small list. */
export function goalDealsHref(orgId: string, team: string, period: GoalPeriod, periodStart: string): string {
  return `/o/${orgId}/reports/goals/deals?${new URLSearchParams({ team, period, start: periodStart })}`;
}

/** Team goals with a deal metric link to the deals they count. */
export function countsDeals(metric: GoalMetric): boolean {
  return metric === "won_amount" || metric === "won_deals";
}

/** The line shown before the quarter day: the pace shows on that day itself. */
export function paceFromText(paceFrom: string): string {
  return `התחזית תוצג החל מ־${calendarDateText(paceFrom)}`;
}
