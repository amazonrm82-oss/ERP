// RPT-03 (owner (386) א): the reports a schedule may name, and the closed lists of periods, frequencies, weekdays and times.
// Pure: shared by the settings page, the server actions and the email. SCHEDULE_CATALOG is derived from the report
// definitions and mirrors app.scheduled_report_catalog() (tests/unit/report-schedules.test.ts reads the migration).

import { REPORTS, type ReportDefinition } from "@/features/reports/definitions";

export type ScheduledReportEntry = {
  key: string;
  hasPeriod: boolean;
  // every plan key the report needs
  features: string[];
  // only owners, admins and managers by role receive it
  restricted: boolean;
  module: "leads" | null;
  // a report about costs: its recipient must also see costs (review fix 6)
  costs: boolean;
};

/** The reports that show costs or cost-based figures (review fix 6): sent only to owners, admins and managers who see costs. */
export const COST_REPORT_KEYS: readonly string[] = ["categories", "campaign_roi", "profit"];

/** The plan keys a report needs: its own capability, or the keys of the balances and collection screens. */
export function reportFeatures(report: ReportDefinition): string[] {
  if (report.feature) return [report.feature];
  if (report.balances) return ["balances", "documents", "payments"];
  if (report.collection) return ["collection", "documents", "payments"];
  return [];
}

export const SCHEDULE_CATALOG: ScheduledReportEntry[] = REPORTS.map((report) => ({
  key: report.key,
  hasPeriod: report.filters.includes("period"),
  features: reportFeatures(report),
  restricted: Boolean(report.managers || report.costs || report.balances || report.collection || COST_REPORT_KEYS.includes(report.key)),
  module: report.module ?? null,
  costs: Boolean(report.costs || COST_REPORT_KEYS.includes(report.key)),
}));

export function scheduleEntry(key: string): ScheduledReportEntry | undefined {
  return SCHEDULE_CATALOG.find((entry) => entry.key === key);
}

export const SCHEDULE_PERIODS = [
  { value: "yesterday", label: "אתמול" },
  { value: "last_7", label: "7 הימים האחרונים" },
  { value: "this_month", label: "מתחילת החודש" },
  { value: "last_month", label: "החודש הקודם" },
  { value: "last_30", label: "30 הימים האחרונים" },
] as const;
export type SchedulePeriod = (typeof SCHEDULE_PERIODS)[number]["value"];

export function isSchedulePeriod(value: unknown): value is SchedulePeriod {
  return typeof value === "string" && SCHEDULE_PERIODS.some((p) => p.value === value);
}

export function periodLabel(value: string | null): string {
  return SCHEDULE_PERIODS.find((p) => p.value === value)?.label ?? "מצב נוכחי";
}

// 0 = Sunday .. 6 = Saturday (extract(dow) in the database)
export const WEEKDAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"] as const;

/** Quarter hours from 06:00 to 22:00 (report_schedules_send_at). */
export const SCHEDULE_TIMES: string[] = Array.from({ length: (22 - 6) * 4 + 1 }, (_, i) => {
  const minutes = 6 * 60 + i * 15;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});

export const MAX_RECIPIENTS = 20;

/** "כל יום עבודה ב-08:00" / "כל יום שני ב-08:00" */
export function frequencyText(frequency: string, weekday: number | null, sendAt: string): string {
  const time = sendAt.slice(0, 5);
  if (frequency === "weekly" && weekday !== null && weekday >= 0 && weekday <= 6) return `כל יום ${WEEKDAYS[weekday]} ב-${time}`;
  return `כל יום עבודה ב-${time}`;
}
