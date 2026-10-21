// AUT-07 (owner's answer of 18 October 2026): the monthly automation runs against the plan's
// max_automation_runs_per_month. The same thresholds as app.execute_automation (migration automation_run_quota):
// a warning from 80% (ceil) and from 100%, and the automations stop at 110% (floor) until the next month or an upgrade.

export type RunQuotaState = { level: "warn" | "full" | "stopped"; text: string } | null;

export function runQuotaStopAt(limit: number): number {
  return Math.floor(limit * 1.1);
}

/** The bar on the automations screen, or null below 80% or without a limit. */
export function runQuotaState(used: number, limit: number | null): RunQuotaState {
  if (limit === null) return null;
  const counts = `${used.toLocaleString("he-IL")} מתוך ${limit.toLocaleString("he-IL")} הרצות החודש`;
  if (used >= runQuotaStopAt(limit)) {
    return {
      level: "stopped",
      text: `האוטומציות נעצרו: ${counts}, וההרצות החודשיות נוצלו. הן יחזרו לרוץ בתחילת החודש הבא, או אחרי הגדלת החבילה. קליטת פניות לא נעצרת.`,
    };
  }
  if (limit > 0 && used >= limit) {
    return { level: "full", text: `הגעתם למכסת ההרצות החודשית (${counts}). אחרי עוד 10% האוטומציות ייעצרו עד תחילת החודש הבא.` };
  }
  if (limit > 0 && used >= Math.ceil(limit * 0.8)) {
    return { level: "warn", text: `ניצלתם 80% ממכסת ההרצות החודשית (${counts}).` };
  }
  return null;
}
