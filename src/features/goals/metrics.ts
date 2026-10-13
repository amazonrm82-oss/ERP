// GOL-01: what a goal can measure, for whom and over what period. Mirrors the check
// constraints of public.goals (migration goals); tests/unit/goals.test.ts keeps them equal.
// Collections ("גבייה") joins GOAL_METRICS with the payments module, together with a
// migration that widens goals_metric_check.

export const GOAL_SCOPES = ["user", "team", "org"] as const;
export type GoalScope = (typeof GOAL_SCOPES)[number];

export const GOAL_PERIODS = ["month", "quarter", "year"] as const;
export type GoalPeriod = (typeof GOAL_PERIODS)[number];

export type GoalMetricDefinition = {
  key: string;
  label: string;
  // money: the target is agorot and is typed in shekels; count: a whole number
  kind: "money" | "count";
  description: string;
};

export const GOAL_METRICS = [
  { key: "won_amount", label: "הכנסה שנסגרה", kind: "money", description: "סכום העסקאות שנסגרו בהצלחה בתקופה." },
  { key: "won_deals", label: "עסקאות שנסגרו", kind: "count", description: "מספר העסקאות שנסגרו בהצלחה בתקופה." },
  { key: "leads_handled", label: "לידים שטופלו", kind: "count", description: "לידים שנוצר איתם מגע ראשון בתקופה." },
  { key: "meetings_held", label: "פגישות שהתקיימו", kind: "count", description: "פגישות שהתקיימו בתקופה." },
] as const satisfies readonly GoalMetricDefinition[];

export type GoalMetric = (typeof GOAL_METRICS)[number]["key"];

export const GOAL_METRIC_KEYS = GOAL_METRICS.map((m) => m.key) as GoalMetric[];

export const GOAL_SCOPE_LABELS: Record<GoalScope, string> = { user: "חבר צוות", team: "צוות", org: "כל העסק" };
export const GOAL_PERIOD_LABELS: Record<GoalPeriod, string> = { month: "חודש", quarter: "רבעון", year: "שנה" };

export function isGoalMetric(value: unknown): value is GoalMetric {
  return typeof value === "string" && (GOAL_METRIC_KEYS as string[]).includes(value);
}

export function goalMetric(key: GoalMetric): GoalMetricDefinition {
  return GOAL_METRICS.find((m) => m.key === key) as GoalMetricDefinition;
}

/** Upper bound of a target, the same as goals_target_check (a billion shekels in agorot). */
export const GOAL_TARGET_MAX = 100_000_000_000;

/** "2026-10" → "2026-10-01"; null for anything else. */
export function monthStart(month: string): string | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const m = Number(match[2]);
  if (year < 2000 || year > 2100 || m < 1 || m > 12) return null;
  return `${match[1]}-${match[2]}-01`;
}

/** The month `offset` months after "YYYY-MM" (negative goes back). */
export function addMonths(month: string, offset: number): string {
  const [year, m] = month.split("-").map(Number);
  const index = year * 12 + (m - 1) + offset;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** First day of the quarter or year that holds `periodStart` ("YYYY-MM-01"). */
export function periodStartOf(period: GoalPeriod, day: string): string {
  const [year, m] = day.split("-").map(Number);
  if (period === "year") return `${year}-01-01`;
  if (period === "quarter") return `${year}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
  return `${year}-${String(m).padStart(2, "0")}-01`;
}

/**
 * A target as typed in a cell: empty means "no goal" (null); shekels for money (up to two
 * decimals, commas allowed) and whole numbers for counts. Returns the stored value or an error.
 */
export function parseTarget(kind: GoalMetricDefinition["kind"], raw: string): { ok: true; value: number | null } | { ok: false; message: string } {
  const text = raw.replace(/[\s,₪]/g, "");
  if (text === "") return { ok: true, value: null };
  if (kind === "money") {
    if (!/^\d+(\.\d{1,2})?$/.test(text)) return { ok: false, message: "סכום בשקלים, בלי סימנים אחרים." };
    const agorot = Math.round(Number(text) * 100);
    return agorot > GOAL_TARGET_MAX ? { ok: false, message: "הסכום גדול מדי." } : { ok: true, value: agorot };
  }
  if (!/^\d+$/.test(text)) return { ok: false, message: "מספר שלם, בלי סימנים אחרים." };
  const value = Number(text);
  return value > GOAL_TARGET_MAX ? { ok: false, message: "המספר גדול מדי." } : { ok: true, value };
}

/** A stored target as it appears in a cell (shekels for money, no thousands separator). */
export function targetText(kind: GoalMetricDefinition["kind"], value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (kind === "money") {
    return value % 100 === 0 ? String(value / 100) : (value / 100).toFixed(2);
  }
  return String(value);
}
