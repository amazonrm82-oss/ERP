import "server-only";

import { formatMoney, formatNumber, zoneDate, zonedIso } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

import { buildReport } from "./build";
import type { ReportSection } from "./definitions";
import { parsePeriod } from "./period";

export type DashboardTile = { label: string; value: string; change: string | null; trend: "up" | "down" | "same" | null };

export type Dashboard = { tiles: DashboardTile[]; reps: ReportSection | null; stuck: ReportSection | null };

type Obj = Record<string, unknown>;
const num = (value: unknown): number => Number(value ?? 0) || 0;

function compare(current: number, previous: number, format: (n: number) => string): Pick<DashboardTile, "change" | "trend"> {
  if (current === previous) {
    return { change: `כמו באותם ימים בחודש שעבר (${format(previous)})`, trend: "same" };
  }
  const direction = current > previous ? "up" : "down";
  if (previous === 0) {
    return { change: `באותם ימים בחודש שעבר: ${format(previous)}`, trend: direction };
  }
  const percent = Math.round((Math.abs(current - previous) / previous) * 100);
  return { change: `${direction === "up" ? "עלייה" : "ירידה"} של ${formatNumber(percent)}% לעומת אותם ימים בחודש שעבר (${format(previous)})`, trend: direction };
}

/** The 1st of last month up to the same day of the month as today (or its last day), as [from, to). */
function sameDaysLastMonth(now: Date): { from: string; to: string } {
  const [year, month, day] = zoneDate(now).split("-").map(Number);
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  const daysInPrev = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate();
  const end = new Date(Date.UTC(prevYear, prevMonth - 1, Math.min(day, daysInPrev) + 1)).toISOString().slice(0, 10);
  const start = `${prevYear}-${String(prevMonth).padStart(2, "0")}-01`;
  return { from: zonedIso(start, "00:00:00"), to: zonedIso(end, "00:00:00") };
}

/** Manager dashboard: this month so far against the same days of last month, plus the pipeline now. */
export async function getDashboard(orgId: string): Promise<Dashboard> {
  const now = new Date();
  const period = parsePeriod({ period: "this_month" }, now);
  const previous = sameDaysLastMonth(now);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("report_summary", {
    p_org: orgId,
    p_from: period.from,
    p_to: period.to,
    p_prev_from: previous.from,
    p_prev_to: previous.to,
  });
  if (error) {
    throw new Error(`report_summary failed: ${error.message}`);
  }
  const s = (data ?? {}) as Obj;
  const winRate = (won: number, lost: number) => (won + lost > 0 ? Math.round((won / (won + lost)) * 100) : 0);
  const percentText = (n: number) => `${formatNumber(n)}%`;

  const tiles: DashboardTile[] = [
    { label: "לידים חדשים החודש", value: formatNumber(num(s.leads)), ...compare(num(s.leads), num(s.leads_prev), formatNumber) },
    { label: "הכנסה שנסגרה החודש", value: formatMoney(num(s.won_amount)), ...compare(num(s.won_amount), num(s.won_amount_prev), formatMoney) },
    {
      label: "אחוז זכייה החודש",
      value: num(s.won) + num(s.lost) > 0 ? percentText(winRate(num(s.won), num(s.lost))) : "—",
      ...(num(s.won) + num(s.lost) + num(s.won_prev) + num(s.lost_prev) > 0
        ? compare(winRate(num(s.won), num(s.lost)), winRate(num(s.won_prev), num(s.lost_prev)), percentText)
        : { change: "עוד לא נסגרו או אבדו עסקאות", trend: null }),
    },
    { label: "עסקאות פתוחות", value: formatNumber(num(s.open)), change: `שווי ${formatMoney(num(s.open_amount))}`, trend: null },
    { label: "שווי משוקלל בפייפליין", value: formatMoney(num(s.weighted_amount)), change: "סכום כפול סיכויי הסגירה", trend: null },
    { label: "משימות באיחור", value: formatNumber(num(s.overdue_tasks)), change: null, trend: null },
  ];

  const filters = { period, ownerId: null, pipelineId: null };
  const [reps, stuck] = await Promise.all([buildReport(orgId, "reps", filters), buildReport(orgId, "stuck", filters)]);
  const stuckSection = stuck.sections[0] ? { ...stuck.sections[0], title: "עסקאות שדורשות טיפול", rows: stuck.sections[0].rows.slice(0, 5) } : null;
  return { tiles, reps: reps.sections[0] ?? null, stuck: stuckSection };
}
