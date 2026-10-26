import "server-only";

import { goalMetric, GOAL_METRIC_KEYS } from "@/features/goals/metrics";
import {
  paceFromText,
  paceStartDay,
  periodEndLabel,
  periodLabel,
  progressFigures,
  reportGoalPeriod,
  requiredPerDayValue,
} from "@/features/goals/progress";
import { getGoalProgress } from "@/features/goals/progress-queries";
import { productPath } from "@/features/products/paths";
import { BILLING_LABELS, type Billing } from "@/features/products/schema";
import { getUserNames } from "@/features/shell/queries";
import type { Database, Json } from "@/lib/database.types";
import { formatDate, formatMoney, formatNumber } from "@/lib/format";
import { paths } from "@/lib/paths";
import { getOrgTerms } from "@/features/terminology/queries";
import { byGender } from "@/features/terminology/terms";
import { createClient } from "@/lib/supabase/server";

import type { ReportRow, ReportSection, ReportView } from "./definitions";
import { formatCell, hourLabel } from "./format";
import type { Period } from "./period";
import { responseTargetLabels } from "./response-target";
import { parseReportData, type ReportFunction } from "./schemas";
import { must } from "@/lib/db-read";

export type ReportFilters = { period: Period; ownerId: string | null; pipelineId: string | null };

type Obj = Record<string, unknown>;

const num = (value: unknown): number => (typeof value === "number" ? value : Number(value ?? 0) || 0);
const numOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : num(value));
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
const list = (value: Json | null): Obj[] => (Array.isArray(value) ? (value as Obj[]) : []);
const obj = (value: Json | null | undefined): Obj => (value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {});

const NO_OWNER = "ללא אחראי";
const monthFormat = new Intl.DateTimeFormat("he-IL", { month: "long", year: "numeric", timeZone: "UTC" });

// RPT-01: a line's billing, and what a total of that billing is
function billingLabel(billing: string | null): string {
  return billing && billing in BILLING_LABELS ? BILLING_LABELS[billing as Billing] : "לפי העסקה";
}
function billingFigureLabel(billing: string | null): string {
  if (billing === "monthly") return "חיוב חודשי";
  if (billing === "quarterly") return "חיוב רבעוני";
  if (billing === "yearly") return "חיוב שנתי";
  return "שורות לפי תקופת העסקה";
}
function billingFigureHint(billing: string | null): string {
  if (billing === "monthly") return "סכום לחודש אחד של השורות החודשיות.";
  if (billing === "quarterly") return "סכום לרבעון אחד של השורות הרבעוניות.";
  if (billing === "yearly") return "סכום לשנה אחת של השורות השנתיות.";
  return "שורות שנשמרו לפני שהיה לשורה סוג חיוב; סכומן לפי תקופת העסקה.";
}

// RPT-01, DLI-06: what the stored line totals of a period are, with VAT or before it (one mode per deal)
function vatModeNote(totals: Record<string, unknown>): string | null {
  const withVat = num(totals.deals_with_vat);
  const withoutVat = num(totals.deals_without_vat);
  if (withVat > 0 && withoutVat > 0) {
    return `שימו לב: בתקופה יש עסקאות שתמחרו כולל מע"מ (${formatNumber(withVat)}) ועסקאות שתמחרו לפני מע"מ (${formatNumber(withoutVat)}), והסכומים כאן לא אוחדו לאחד מהם.`;
  }
  if (withVat > 0) return 'כל הסכומים כאן כוללים מע"מ, כפי שתומחרו בעסקאות.';
  if (withoutVat > 0) return 'כל הסכומים כאן לפני מע"מ, כפי שתומחרו בעסקאות.';
  return null;
}

function monthLabel(month: unknown): string {
  const value = str(month);
  return value ? monthFormat.format(new Date(`${value.slice(0, 10)}T12:00:00Z`)) : "ללא תאריך צפוי";
}

type Functions = Database["public"]["Functions"];
type ReportFn = Extract<keyof Functions, `report_${string}`>;

/** One report function with the user's session; its result is checked against its schema (FXC-12). */
async function rpc<N extends ReportFn & ReportFunction>(name: N, args: Functions[N]["Args"]): Promise<Json> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    throw new Error(`${name} failed: ${error.message}`);
  }
  // a mismatch throws ReportShapeError; withReportShape() logs it and shows the message
  parseReportData(name, data);
  return data as Json;
}

async function ownerNames(ids: unknown[]): Promise<(id: unknown) => string> {
  const names = await getUserNames(ids.map((id) => str(id)));
  return (id) => {
    const value = str(id);
    return value ? (names.get(value) ?? "משתמש") : NO_OWNER;
  };
}

/** Runs one report with the user's session (RLS decides what is counted) and shapes it for display and export. */
/**
 * GOL-03 in the rep performance report: one table per metric with the people's goals of the
 * report's period (a whole month, quarter or year), what they did, the percent and the pace.
 */
async function repGoalSections(orgId: string, filters: ReportFilters): Promise<{ sections: ReportSection[]; note: string | null }> {
  const { period, pipelineId } = filters;
  const goalPeriod = reportGoalPeriod(period.key, period.fromDate, period.toDate);
  if (!goalPeriod) {
    return { sections: [], note: "עמידה ביעד מוצגת כשהתקופה היא חודש, רבעון או שנה שלמים." };
  }
  const people = (await getGoalProgress(orgId, { period: goalPeriod })).filter((g) => g.scope === "user");
  const sections = GOAL_METRIC_KEYS.flatMap((metric): ReportSection[] => {
    const rows = people.filter((g) => g.metric === metric);
    if (rows.length === 0) return [];
    const definition = goalMetric(metric);
    const kind = definition.kind === "money" ? ("money" as const) : ("number" as const);
    const today = rows[0].today;
    const paceFrom = paceStartDay(goalPeriod.period, goalPeriod.periodStart);
    const notes = [
      definition.description,
      today < paceFrom ? `${paceFromText(paceFrom)}.` : null,
      pipelineId ? "היעדים נמדדים בכל תהליכי המכירה, בלי קשר לסינון." : null,
    ];
    return [
      {
        title: `עמידה ביעד: ${definition.label}, ${periodLabel(goalPeriod.period, goalPeriod.periodStart)}`,
        columns: [
          { key: "owner", label: "חבר צוות", kind: "text" },
          { key: "actual", label: "בפועל", kind },
          { key: "target", label: "יעד", kind },
          { key: "percent", label: "אחוז מהיעד", kind: "percent" },
          { key: "projected", label: `קצב צפוי ${periodEndLabel(goalPeriod.period)}`, kind },
          { key: "projected_percent", label: "צפי באחוזים", kind: "percent" },
          { key: "required_per_day", label: "נדרש ליום", kind },
        ],
        rows: rows
          .map((r) => {
            const figures = progressFigures(r, r.today);
            return {
              owner: r.subject,
              actual: r.actual,
              target: r.target,
              percent: figures.percent,
              projected: figures.projected,
              projected_percent: figures.projectedPercent,
              required_per_day: figures.requiredPerDay === null ? null : requiredPerDayValue(metric, figures.requiredPerDay),
            };
          })
          .sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1)),
        bar: "percent",
        empty: "",
        note: notes.filter(Boolean).join(" "),
      },
    ];
  });
  return { sections, note: null };
}

export async function buildReport(orgId: string, key: string, filters: ReportFilters, options: { goals?: boolean } = {}): Promise<ReportView> {
  // FLD-10 part two: titles and column headers name leads and deals in the business's own words (notes and empty texts
  // keep today's words)
  const terms = await getOrgTerms(orgId);
  const L = terms.lead;
  const D = terms.deal;
  const newLeads = `${L.plural} ${byGender(L, "חדשים", "חדשות")}`;
  const averageDeal = `${D.singular} ${byGender(D, "ממוצע", "ממוצעת")}`;
  const { period, ownerId, pipelineId } = filters;
  const range = { p_org: orgId, p_from: period.from, p_to: period.to };

  switch (key) {
    case "sources": {
      const rows = list(await rpc("report_leads_by_source", { ...range, p_owner: ownerId }));
      const supabase = await createClient();
      const sources = must(await supabase.from("lead_sources").select("id, name").eq("organization_id", orgId), "lead_sources");
      const sourceName = new Map((sources ?? []).map((s) => [s.id, s.name]));
      const bySource = new Map<string, { name: string; leads: number; converted: number; won: number; revenue: number }>();
      for (const r of rows) {
        const id = str(r.source_id) ?? "";
        const entry = bySource.get(id) ?? { name: str(r.source_name) ?? sourceName.get(id) ?? "ללא מקור", leads: 0, converted: 0, won: 0, revenue: 0 };
        entry.leads += num(r.leads);
        entry.converted += num(r.converted);
        entry.won += num(r.won);
        entry.revenue += num(r.revenue);
        bySource.set(id, entry);
      }
      const totals = [...bySource.values()].reduce((t, s) => ({ leads: t.leads + s.leads, converted: t.converted + s.converted, revenue: t.revenue + s.revenue }), { leads: 0, converted: 0, revenue: 0 });
      const columns = [
        { key: "leads", label: L.plural, kind: "number" as const },
        { key: "converted", label: "הומרו", kind: "number" as const },
        { key: "rate", label: "אחוז המרה", kind: "percent" as const },
        { key: "won", label: `${D.plural} שנסגרו`, kind: "number" as const },
        { key: "revenue", label: "הכנסה", kind: "money" as const },
      ];
      return {
        kpis: [
          { label: L.plural, value: formatNumber(totals.leads) },
          { label: "אחוז המרה", value: totals.leads ? `${pct(totals.converted, totals.leads)}%` : "—" },
          { label: `הכנסה מ${L.plural}`, value: formatMoney(totals.revenue) },
        ],
        sections: [
          {
            title: "לפי מקור",
            columns: [{ key: "name", label: "מקור", kind: "text" }, ...columns],
            rows: [...bySource.values()]
              .sort((a, b) => b.leads - a.leads)
              .map((s) => ({ name: s.name, leads: s.leads, converted: s.converted, rate: pct(s.converted, s.leads), won: s.won, revenue: s.revenue })),
            bar: "leads",
            empty: "אין לידים בתקופה הזו.",
          },
          {
            title: "לפי קמפיין",
            columns: [{ key: "source", label: "מקור", kind: "text" }, { key: "campaign", label: "קמפיין", kind: "text" }, ...columns],
            rows: rows
              .filter((r) => str(r.campaign))
              .map((r) => ({
                source: str(r.source_name) ?? "ללא מקור",
                campaign: str(r.campaign),
                leads: num(r.leads),
                converted: num(r.converted),
                rate: pct(num(r.converted), num(r.leads)),
                won: num(r.won),
                revenue: num(r.revenue),
              })),
            empty: "אין לידים עם שם קמפיין בתקופה הזו. שם הקמפיין מגיע מטפסים ומ-webhook (utm_campaign).",
          },
        ],
      };
    }

    case "funnel": {
      const data = obj(await rpc("report_funnel", { ...range, p_owner: ownerId, p_pipeline: pipelineId }));
      const leads = obj(data.leads as Json);
      const created = num(leads.created);
      const steps = [
        { step: newLeads, count: created },
        { step: "נוצר מגע", count: num(leads.contacted) },
        { step: "הומרו ללקוח", count: num(leads.converted) },
        { step: `${D.singular} ${byGender(D, "נסגר", "נסגרה")} בהצלחה`, count: num(leads.won) },
      ];
      const stages = list(data.stages as Json);
      const deals = obj(data.deals as Json);
      const firstStage = stages.length ? num(stages[0].reached) : 0;
      return {
        kpis: [
          { label: newLeads, value: formatNumber(created) },
          { label: `מ${L.singular} ל${D.singular} ${byGender(D, "שנסגר", "שנסגרה")}`, value: created ? `${pct(num(leads.won), created)}%` : "—" },
          { label: `${D.plural} שנפתחו`, value: formatNumber(num(deals.deals)), hint: `נסגרו ${formatNumber(num(deals.won))}, אבדו ${formatNumber(num(deals.lost))}` },
        ],
        sections: [
          {
            title: `מ${L.singular} ללקוח`,
            columns: [
              { key: "step", label: "שלב", kind: "text" },
              { key: "count", label: "כמות", kind: "number" },
              { key: "of_first", label: `מתוך ${L.thePlural}`, kind: "percent" },
              { key: "of_prev", label: "מהשלב הקודם", kind: "percent" },
            ],
            rows: steps.map((s, i) => ({ step: s.step, count: s.count, of_first: pct(s.count, created), of_prev: i === 0 ? null : pct(s.count, steps[i - 1].count) })),
            bar: "count",
            empty: "אין לידים בתקופה הזו.",
            note: "\"נוצר מגע\": נרשמה לליד שיחה, פגישה, הודעה או הערה, או שהליד הומר.",
          },
          {
            title: `שלבי תהליך המכירה (${D.plural} שנפתחו בתקופה)`,
            columns: [
              { key: "name", label: "שלב", kind: "text" },
              { key: "reached", label: "הגיעו לשלב", kind: "number" },
              { key: "of_first", label: "מתוך הראשון", kind: "percent" },
              { key: "of_prev", label: "מהשלב הקודם", kind: "percent" },
            ],
            rows: stages.map((s, i) => ({
              name: str(s.name),
              reached: num(s.reached),
              of_first: pct(num(s.reached), firstStage),
              of_prev: i === 0 ? null : pct(num(s.reached), num(stages[i - 1].reached)),
            })),
            bar: "reached",
            empty: "אין עסקאות שנפתחו בתקופה הזו.",
          },
        ],
      };
    }

    case "response": {
      const [ownerData, breakdownData] = await Promise.all([
        rpc("report_response_time", { ...range, p_owner: ownerId }),
        rpc("report_response_breakdown", { ...range, p_owner: ownerId }),
      ]);
      const rows = list(ownerData);
      const breakdown = obj(breakdownData);
      const target = num(breakdown.target_minutes);
      const labels = responseTargetLabels(target);
      const shareNote = `האחוז בעמודת "${labels.column}" הוא מתוך כל הלידים בתקופה, כולל לידים שעוד לא נוצר איתם מגע.`;
      const name = await ownerNames(rows.map((r) => r.owner_id));
      const leads = rows.reduce((s, r) => s + num(r.leads), 0);
      const contacted = rows.reduce((s, r) => s + num(r.contacted), 0);
      const withinTarget = rows.reduce((s, r) => s + num(r.within_target), 0);
      const weighted = rows.reduce((s, r) => s + num(r.avg_minutes) * num(r.contacted), 0);
      const measures = (r: Obj) => ({
        leads: num(r.leads),
        contacted: num(r.contacted),
        within_target: pct(num(r.within_target), num(r.leads)),
        avg: numOrNull(r.avg_minutes),
        median: numOrNull(r.median_minutes),
      });
      const measureColumns = [
        { key: "leads", label: L.plural, kind: "number" as const },
        { key: "contacted", label: "נוצר מגע", kind: "number" as const },
        { key: "within_target", label: labels.column, kind: "percent" as const },
        { key: "avg", label: "ממוצע", kind: "minutes" as const },
        { key: "median", label: "חציון", kind: "minutes" as const },
      ];
      return {
        kpis: [
          { label: "זמן ממוצע עד מגע ראשון", value: contacted ? formatCell("minutes", weighted / contacted) : "—" },
          { label: labels.kpi, value: leads ? `${pct(withinTarget, leads)}%` : "—", hint: labels.clock },
          { label: `${L.plural} בלי מגע`, value: formatNumber(leads - contacted) },
        ],
        sections: [
          {
            title: "לפי חבר צוות",
            columns: [{ key: "owner", label: "חבר צוות", kind: "text" }, ...measureColumns],
            rows: rows.map((r) => ({ owner: name(r.owner_id), ...measures(r) })),
            empty: "אין לידים בתקופה הזו.",
            note: `מגע ראשון: השיחה, הפגישה, ההודעה או ההערה הראשונה שנרשמה בליד (לא הערה פרטית). בציר הזמן של הליד בוחרים את סוג הפעילות. ${shareNote}`,
          },
          {
            title: "לפי מקור",
            columns: [{ key: "source", label: "מקור", kind: "text" }, ...measureColumns],
            rows: list(breakdown.by_source as Json).map((r) => ({ source: str(r.source_name) ?? "ללא מקור", ...measures(r) })),
            bar: "leads",
            empty: "אין לידים בתקופה הזו.",
            note: shareNote,
          },
          {
            title: "לפי שעת ההגעה",
            columns: [{ key: "hour", label: `${L.theSingular} ${byGender(L, "הגיע", "הגיעה")}`, kind: "text" }, ...measureColumns],
            rows: list(breakdown.by_hour as Json).map((r) => ({ hour: hourLabel(num(r.hour)), ...measures(r) })),
            bar: "leads",
            empty: "אין לידים בתקופה הזו.",
            note: `השעה לפי אזור הזמן של העסק. ${shareNote} הזמן נספר בשעון רגיל, גם מחוץ לשעות העבודה.`,
          },
        ],
      };
    }

    case "reps": {
      const [rows, goals] = await Promise.all([
        rpc("report_rep_performance", { ...range, p_pipeline: pipelineId }).then(list),
        options.goals === false ? Promise.resolve({ sections: [], note: null }) : repGoalSections(orgId, filters),
      ]);
      const name = await ownerNames(rows.map((r) => r.owner_id));
      const won = rows.reduce((s, r) => s + num(r.won), 0);
      const lost = rows.reduce((s, r) => s + num(r.lost), 0);
      const amount = rows.reduce((s, r) => s + num(r.won_amount), 0);
      return {
        kpis: [
          { label: `${D.plural} שנסגרו`, value: formatNumber(won) },
          { label: "סכום שנסגר", value: formatMoney(amount) },
          { label: "אחוז סגירה בהצלחה", value: won + lost ? `${pct(won, won + lost)}%` : "—" },
        ],
        sections: [
          {
            title: "לפי חבר צוות",
            columns: [
              { key: "owner", label: "חבר צוות", kind: "text" },
              { key: "won", label: "נסגרו", kind: "number" },
              { key: "won_amount", label: "סכום", kind: "money" },
              { key: "lost", label: "אבדו", kind: "number" },
              { key: "win_rate", label: "אחוז סגירה בהצלחה", kind: "percent" },
              { key: "avg_deal", label: averageDeal, kind: "money" },
              { key: "open_count", label: "פתוחות עכשיו", kind: "number" },
              { key: "open_amount", label: "שווי פתוחות", kind: "money" },
            ],
            rows: rows.map((r) => ({
              owner: name(r.owner_id),
              won: num(r.won),
              won_amount: num(r.won_amount),
              lost: num(r.lost),
              win_rate: pct(num(r.won), num(r.won) + num(r.lost)),
              avg_deal: num(r.won) ? Math.round(num(r.won_amount) / num(r.won)) : null,
              open_count: num(r.open_count),
              open_amount: num(r.open_amount),
            })),
            bar: "won_amount",
            empty: "אין עסקאות בתקופה הזו.",
            ...(goals.note ? { note: goals.note } : {}),
          },
          ...goals.sections,
        ],
      };
    }

    case "activity": {
      const data = obj(await rpc("report_activity", { ...range, p_owner: ownerId }));
      const byUser = list(data.by_user as Json);
      const byDay = list(data.by_day as Json);
      const name = await ownerNames(byUser.map((r) => r.user_id));
      const total = (r: Obj) => num(r.call) + num(r.meeting) + num(r.messages) + num(r.note);
      return {
        kpis: [
          { label: "שיחות", value: formatNumber(byUser.reduce((s, r) => s + num(r.call), 0)) },
          { label: "פגישות", value: formatNumber(byUser.reduce((s, r) => s + num(r.meeting), 0)) },
          { label: "משימות שהושלמו", value: formatNumber(byUser.reduce((s, r) => s + num(r.tasks_done), 0)) },
        ],
        sections: [
          {
            title: "לפי חבר צוות",
            columns: [
              { key: "user", label: "חבר צוות", kind: "text" },
              { key: "call", label: "שיחות", kind: "number" },
              { key: "meeting", label: "פגישות", kind: "number" },
              { key: "messages", label: "הודעות", kind: "number" },
              { key: "note", label: "הערות", kind: "number" },
              { key: "tasks_done", label: "משימות שהושלמו", kind: "number" },
              { key: "total", label: "סה\"כ פעילויות", kind: "number" },
            ],
            rows: byUser
              .map((r) => ({ user: name(r.user_id), call: num(r.call), meeting: num(r.meeting), messages: num(r.messages), note: num(r.note), tasks_done: num(r.tasks_done), total: total(r) }))
              .sort((a, b) => b.total - a.total),
            bar: "total",
            empty: "לא נרשמה פעילות בתקופה הזו.",
            note: "הודעות: אימייל, WhatsApp ו-SMS שנרשמו בציר הזמן.",
          },
          {
            title: "לפי יום",
            columns: [
              { key: "day", label: "יום", kind: "text" },
              { key: "activities", label: "פעילויות", kind: "number" },
              { key: "tasks_done", label: "משימות שהושלמו", kind: "number" },
            ],
            rows: byDay.map((r) => ({
              day: new Intl.DateTimeFormat("he-IL", { weekday: "short", day: "numeric", month: "numeric", timeZone: "UTC" }).format(new Date(`${str(r.day)}T12:00:00Z`)),
              activities: num(r.activities),
              tasks_done: num(r.tasks_done),
            })),
            bar: "activities",
            empty: "לא נרשמה פעילות בתקופה הזו.",
          },
        ],
      };
    }

    case "forecast": {
      // GOL-04: weighted open deals by expected close month against the month's revenue goal
      const data = parseReportData("report_goal_forecast", await rpc("report_goal_forecast", { p_org: orgId, p_pipeline: pipelineId, p_owner: ownerId }));
      const name = await ownerNames([...data.by_owner.map((r) => r.owner_id), ...data.overdue_deals.map((r) => r.owner_id), ownerId]);
      const thisMonth = `${data.today.slice(0, 7)}-01`;
      const current = data.months.find((m) => m.month.slice(0, 10) === thisMonth);
      const currentForecast = current ? current.won_amount + current.weighted : 0;
      const totalWeighted = data.months.reduce((s, m) => s + m.weighted, 0) + data.overdue.weighted + data.undated.weighted;
      const goalOf = (forecast: number, goal: number | null) => (goal ? pct(forecast, goal) : null);
      // no comparison with the goal when the caller does not see every deal it is about, or a pipeline is
      // picked (a goal covers every pipeline); the database returns no goal then either
      const withGoal = data.complete && !pipelineId;
      const overdueMore = data.overdue.weighted > 0 ? `ועוד ${formatMoney(data.overdue.weighted)} בעסקאות שתאריך הסגירה שלהן עבר` : null;
      const goalWho = data.goal_scope === "user" && ownerId ? `היעד האישי של ${name(ownerId)}` : "יעד ההכנסה של כל העסק";
      const pipelines = new Set(data.by_stage.map((r) => r.pipeline_id));
      const split = (kind: "owner" | "stage") => [
        { key: kind, label: kind === "owner" ? "חבר צוות" : "שלב", kind: "text" as const },
        { key: "deals", label: D.plural, kind: "number" as const },
        { key: "amount", label: "שווי", kind: "money" as const },
        { key: "weighted", label: "משוקלל", kind: "money" as const },
        { key: "month_weighted", label: "משוקלל לחודש הזה", kind: "money" as const },
        { key: "overdue_deals", label: "תאריך הסגירה עבר", kind: "number" as const },
        { key: "overdue_weighted", label: "משוקלל, תאריך עבר", kind: "money" as const },
      ];
      const splitRow = (r: { deals: number; amount: number; weighted: number; month_weighted: number; overdue_deals: number; overdue_weighted: number }) => ({
        deals: r.deals,
        amount: r.amount,
        weighted: r.weighted,
        month_weighted: r.month_weighted,
        overdue_deals: r.overdue_deals,
        overdue_weighted: r.overdue_weighted,
      });
      const line = (label: string, l: { deals: number; amount: number; weighted: number }): ReportRow => ({
        month: label,
        deals: l.deals,
        amount: l.amount,
        weighted: l.weighted,
        won_amount: null,
        forecast: null,
        goal: null,
        goal_percent: null,
      });
      return {
        kpis: [
          {
            label: "צפי לחודש הזה",
            value: formatMoney(currentForecast),
            hint: [
              withGoal
                ? current?.goal
                  ? `${formatNumber(goalOf(currentForecast, current.goal) ?? 0)}% מיעד של ${formatMoney(current.goal)}`
                  : "אין יעד הכנסה לחודש הזה"
                : null,
              overdueMore,
            ]
              .filter(Boolean)
              .join(". "),
          },
          { label: "שווי משוקלל", value: formatMoney(totalWeighted), hint: "סכום כל עסקה פתוחה כפול סיכויי הסגירה שלה" },
          {
            label: "תאריך הסגירה עבר",
            value: formatNumber(data.overdue.deals),
            hint: data.overdue.deals ? `עסקאות פתוחות, משוקלל ${formatMoney(data.overdue.weighted)}` : "אין עסקאות פתוחות שהתאריך שלהן עבר",
          },
        ],
        sections: [
          {
            title: withGoal ? "לפי חודש סגירה צפוי, מול היעד" : "לפי חודש סגירה צפוי",
            columns: [
              { key: "month", label: "חודש", kind: "text" },
              { key: "deals", label: D.plural, kind: "number" },
              { key: "amount", label: "שווי", kind: "money" },
              { key: "weighted", label: "משוקלל", kind: "money" },
              { key: "won_amount", label: "כבר נסגר", kind: "money" },
              { key: "forecast", label: "צפי", kind: "money" },
              ...(withGoal
                ? [
                    { key: "goal", label: "יעד", kind: "money" as const },
                    { key: "goal_percent", label: "צפי מול יעד", kind: "percent" as const },
                  ]
                : []),
            ],
            rows: [
              // the line opens the list of those deals below, with what can be done with each
              ...(data.overdue.deals ? [{ ...line("תאריך הסגירה עבר", data.overdue), _href: "#overdue-deals" }] : []),
              ...data.months.map((m) => {
                const forecast = m.won_amount + m.weighted;
                return {
                  month: monthLabel(m.month),
                  deals: m.deals,
                  amount: m.amount,
                  weighted: m.weighted,
                  won_amount: m.won_amount,
                  forecast,
                  goal: m.goal,
                  goal_percent: goalOf(forecast, m.goal),
                };
              }),
              ...(data.undated.deals ? [line("ללא תאריך צפוי", data.undated)] : []),
            ],
            bar: "weighted",
            empty: "אין עסקאות פתוחות.",
            note: [
              "צפי: מה שכבר נסגר בחודש ועוד השווי המשוקלל של העסקאות הפתוחות שצפויות להיסגר בו.",
              withGoal ? `יעד: ${goalWho} לחודש.` : null,
              pipelineId ? "היעדים נמדדים בכל תהליכי המכירה, ולכן הם לא מוצגים כשבוחרים תהליך מכירה." : null,
              "עסקאות שתאריך הסגירה שלהן עבר לא נכנסות לאף חודש, והן בשורה נפרדת.",
              overdueMore ? `${overdueMore}.` : null,
            ]
              .filter(Boolean)
              .join(" "),
          },
          {
            title: "לפי חבר צוות",
            columns: split("owner"),
            rows: data.by_owner.map((r) => ({ owner: name(r.owner_id), ...splitRow(r) })),
            bar: "weighted",
            empty: "אין עסקאות פתוחות.",
          },
          {
            title: "לפי שלב",
            columns: split("stage"),
            rows: data.by_stage.map((r) => ({
              stage: pipelines.size > 1 ? `${r.pipeline_name ?? "תהליך מכירה"}: ${r.name ?? "שלב"}` : (r.name ?? "שלב"),
              ...splitRow(r),
            })),
            bar: "weighted",
            empty: "אין עסקאות פתוחות.",
          },
          {
            title: `${D.plural} שתאריך הסגירה ${byGender(D, "שלהם", "שלהן")} עבר`,
            anchor: "overdue-deals",
            columns: [
              { key: "deal", label: D.singular, kind: "text" },
              { key: "owner", label: "חבר צוות", kind: "text" },
              { key: "stage", label: "שלב", kind: "text" },
              { key: "expected", label: "תאריך סגירה צפוי", kind: "text" },
              { key: "amount", label: "שווי", kind: "money" },
              { key: "weighted", label: "משוקלל", kind: "money" },
            ],
            rows: data.overdue_deals.map((d) => ({
              deal: d.name ?? "עסקה",
              _href: paths.deal(orgId, d.id),
              owner: name(d.owner_id),
              stage: d.stage_name,
              expected: `${formatDate(`${d.expected_close_date.slice(0, 10)}T12:00:00Z`)} (עבר)`,
              amount: d.amount_agorot,
              weighted: d.weighted,
            })),
            empty: "אין עסקאות פתוחות שתאריך הסגירה שלהן עבר.",
            note:
              data.overdue.deals > data.overdue_deals.length
                ? `מוצגות ${formatNumber(data.overdue_deals.length)} העסקאות הוותיקות מתוך ${formatNumber(data.overdue.deals)}. כדאי לעדכן להן תאריך או לסגור אותן.`
                : "כדאי לעדכן להן תאריך סגירה או לסגור אותן.",
          },
        ],
        overdueTotal: data.overdue.deals,
        overdueDeals: data.overdue_deals.map((d) => ({
          id: d.id,
          name: d.name ?? "עסקה",
          ownerId: d.owner_id,
          ownerName: name(d.owner_id),
          pipelineId: d.pipeline_id,
          stageName: d.stage_name,
          amount: d.amount_agorot,
          weighted: d.weighted,
          expected: d.expected_close_date.slice(0, 10),
        })),
      };
    }

    case "lost": {
      const data = obj(await rpc("report_lost_reasons", { ...range, p_pipeline: pipelineId, p_owner: ownerId }));
      const byReason = list(data.by_reason as Json);
      const byStage = list(data.by_stage as Json);
      const byOwner = list(data.by_owner as Json);
      // DEAL-03: the competitor the deal was lost to, when someone wrote it
      const byCompetitor = list(data.by_competitor as Json);
      const name = await ownerNames(byOwner.map((r) => r.owner_id));
      const total = byReason.reduce((s, r) => s + num(r.deals), 0);
      return {
        kpis: [
          { label: `${D.plural} שאבדו`, value: formatNumber(total) },
          { label: "שווי שאבד", value: formatMoney(byReason.reduce((s, r) => s + num(r.amount), 0)) },
        ],
        sections: [
          {
            title: "לפי סיבה",
            columns: [
              { key: "reason", label: "סיבה", kind: "text" },
              { key: "deals", label: D.plural, kind: "number" },
              { key: "share", label: "מתוך כולן", kind: "percent" },
              { key: "amount", label: "שווי", kind: "money" },
            ],
            rows: byReason.map((r) => ({ reason: str(r.reason) ?? "לא צוינה סיבה", deals: num(r.deals), share: pct(num(r.deals), total), amount: num(r.amount) })),
            bar: "deals",
            empty: "לא אבדו עסקאות בתקופה הזו.",
          },
          {
            title: "באיזה שלב אבדו",
            columns: [
              { key: "stage", label: "השלב לפני ההפסד", kind: "text" },
              { key: "deals", label: D.plural, kind: "number" },
            ],
            // stages in pipeline order; deals with no recorded stage move last
            rows: [...byStage]
              .sort((a, b) => {
                const pa = numOrNull(a.position);
                const pb = numOrNull(b.position);
                return pa === pb ? 0 : pa === null ? 1 : pb === null ? -1 : pa - pb;
              })
              .map((r) => ({ stage: str(r.name) ?? (r.stage_id ? "שלב שנמחק" : "לא נרשם מעבר שלב"), deals: num(r.deals) })),
            bar: "deals",
            empty: "לא אבדו עסקאות בתקופה הזו.",
          },
          {
            title: "לפי חבר צוות",
            columns: [
              { key: "owner", label: "חבר צוות", kind: "text" },
              { key: "deals", label: D.plural, kind: "number" },
              { key: "amount", label: "שווי", kind: "money" },
            ],
            rows: byOwner.map((r) => ({ owner: name(r.owner_id), deals: num(r.deals), amount: num(r.amount) })),
            empty: "לא אבדו עסקאות בתקופה הזו.",
          },
          {
            title: "לפי מתחרה",
            columns: [
              { key: "competitor", label: "מתחרה", kind: "text" },
              { key: "deals", label: D.plural, kind: "number" },
              { key: "amount", label: "שווי", kind: "money" },
            ],
            rows: byCompetitor.map((r) => ({ competitor: str(r.competitor) ?? "", deals: num(r.deals), amount: num(r.amount) })),
            bar: "deals",
            empty: "לא נרשם מתחרה בעסקאות שאבדו בתקופה הזו.",
          },
        ],
      };
    }

    case "cycle": {
      const data = obj(await rpc("report_cycle_length", { ...range, p_pipeline: pipelineId, p_owner: ownerId }));
      const stages = list(data.stages as Json);
      return {
        kpis: [
          { label: `ממוצע מפתיחת ${D.singular} לסגירה`, value: formatCell("days", numOrNull(data.avg_days)), hint: `חציון: ${formatCell("days", numOrNull(data.median_days))}` },
          { label: `ממוצע מ${L.singular} לסגירה`, value: formatCell("days", numOrNull(data.avg_days_from_lead)), hint: `${formatNumber(num(data.from_lead))} עסקאות שהתחילו כליד` },
          { label: `${D.plural} שנסגרו`, value: formatNumber(num(data.won)) },
        ],
        sections: [
          {
            title: "זמן בכל שלב",
            columns: [
              { key: "stage", label: "שלב", kind: "text" },
              { key: "avg_days", label: "ממוצע ימים", kind: "days" },
              { key: "moves", label: "מעברים שנמדדו", kind: "number" },
            ],
            rows: stages.map((r) => ({ stage: str(r.name), avg_days: numOrNull(r.avg_days), moves: num(r.moves) })),
            bar: "avg_days",
            empty: "לא עברו עסקאות בין שלבים בתקופה הזו.",
            note: "נמדד ממעברי שלב שקרו בתקופה: כמה ימים העסקה הייתה בשלב לפני שעברה ממנו.",
          },
        ],
      };
    }

    case "stuck": {
      const rows = list(await rpc("report_stuck_deals", { p_org: orgId, p_pipeline: pipelineId, p_owner: ownerId }));
      const name = await ownerNames(rows.map((r) => r.owner_id));
      return {
        kpis: [
          { label: `${D.plural} ${byGender(D, "תקועים", "תקועות")}`, value: formatNumber(rows.filter((r) => r.stuck === true).length) },
          { label: "שווי התקועות", value: formatMoney(rows.filter((r) => r.stuck === true).reduce((s, r) => s + num(r.amount_agorot), 0)) },
          { label: "בלי צעד הבא", value: formatNumber(rows.filter((r) => r.no_next_step === true).length) },
        ],
        sections: [
          {
            title: `${D.plural} לטיפול`,
            columns: [
              { key: "name", label: D.singular, kind: "text" },
              { key: "stage", label: "שלב", kind: "text" },
              { key: "owner", label: "חבר צוות", kind: "text" },
              { key: "amount", label: "סכום", kind: "money" },
              { key: "idle_days", label: "ימים מאז פעילות", kind: "number" },
              { key: "days_in_stage", label: "ימים בשלב", kind: "number" },
              { key: "why", label: "למה", kind: "text" },
            ],
            rows: rows.map(
              (r): ReportRow => ({
                _href: str(r.id) ? paths.deal(orgId, str(r.id) as string) : null,
                name: str(r.name),
                stage: str(r.stage_name),
                owner: name(r.owner_id),
                amount: num(r.amount_agorot),
                idle_days: num(r.idle_days),
                days_in_stage: num(r.days_in_stage),
                why: [
                  r.stuck === true ? `יותר מ-${formatNumber(num(r.limit_days))} ימים בשלב` : null,
                  r.postponed === true && str(r.snoozed_until) ? `נדחתה עד ${formatDate(str(r.snoozed_until))}` : null,
                  r.no_next_step === true ? "אין משימה או פגישה הבאה" : null,
                  r.last_activity_at ? null : "אין פעילות",
                ]
                  .filter(Boolean)
                  .join(", "),
              }),
            ),
            empty: "אין עסקאות תקועות. כל העסקאות הפתוחות מטופלות.",
            note: "תקועה: נמצאת בשלב יותר מהימים שהוגדרו לו (ברירת מחדל 14), ולא נדחתה לתאריך. מופיעות גם עסקאות שנדחו ועסקאות בלי משימה פתוחה ובלי פגישה מתוכננת. התקועות ראשונות, ובתוכן אלה בלי פעילות.",
          },
        ],
      };
    }

    case "revenue": {
      const data = obj(await rpc("report_revenue", { ...range, p_pipeline: pipelineId, p_owner: ownerId }));
      const byMonth = list(data.by_month as Json);
      const byOwner = list(data.by_owner as Json);
      const byCustomer = list(data.by_customer as Json);
      const name = await ownerNames(byOwner.map((r) => r.owner_id));
      const amount = byMonth.reduce((s, r) => s + num(r.amount), 0);
      const deals = byMonth.reduce((s, r) => s + num(r.deals), 0);
      return {
        kpis: [
          { label: "הכנסה שנסגרה", value: formatMoney(amount) },
          { label: D.plural, value: formatNumber(deals) },
          { label: averageDeal, value: deals ? formatMoney(Math.round(amount / deals)) : "—" },
        ],
        sections: [
          {
            title: "לפי חודש",
            columns: [
              { key: "month", label: "חודש", kind: "text" },
              { key: "deals", label: D.plural, kind: "number" },
              { key: "amount", label: "הכנסה", kind: "money" },
            ],
            rows: byMonth.map((r) => ({ month: monthLabel(r.month), deals: num(r.deals), amount: num(r.amount) })),
            bar: "amount",
            empty: "לא נסגרו עסקאות בתקופה הזו.",
          },
          {
            title: "לפי חבר צוות",
            columns: [
              { key: "owner", label: "חבר צוות", kind: "text" },
              { key: "deals", label: D.plural, kind: "number" },
              { key: "amount", label: "הכנסה", kind: "money" },
            ],
            rows: byOwner.map((r) => ({ owner: name(r.owner_id), deals: num(r.deals), amount: num(r.amount) })),
            bar: "amount",
            empty: "לא נסגרו עסקאות בתקופה הזו.",
          },
          {
            title: "10 הלקוחות המובילים",
            columns: [
              { key: "customer", label: "לקוח", kind: "text" },
              { key: "deals", label: D.plural, kind: "number" },
              { key: "amount", label: "הכנסה", kind: "money" },
            ],
            rows: byCustomer.map(
              (r): ReportRow => ({
                _href: str(r.company_id) ? paths.company(orgId, str(r.company_id) as string) : str(r.contact_id) ? paths.contact(orgId, str(r.contact_id) as string) : null,
                customer: str(r.name) ?? "בלי לקוח משויך",
                deals: num(r.deals),
                amount: num(r.amount),
              }),
            ),
            empty: "לא נסגרו עסקאות בתקופה הזו.",
            note: "הכנסה לפי מוצר: בדוח \"הכנסה לפי מוצר\".",
          },
        ],
      };
    }

    // SEG-02: the deals won in the period by first source and campaign (owner, 18 October 2026: by first source)
    case "source_revenue": {
      const data = obj(await rpc("report_revenue_by_source", { ...range, p_pipeline: pipelineId, p_owner: ownerId }));
      const totals = obj(data.totals as Json);
      const bySource = list(data.by_source as Json);
      const byCampaign = list(data.by_campaign as Json);
      const sourceName = (r: Obj) => (str(r.source_id) ? (str(r.source_name) ?? "מקור") : "ללא מקור");
      const throughDeal = num(totals.from_deal);
      return {
        kpis: [
          { label: "הכנסה", value: formatMoney(num(totals.amount)), hint: `${formatNumber(num(totals.deals))} ${D.plural} שנסגרו` },
          { label: "מקורות", value: formatNumber(bySource.filter((r) => str(r.source_id)).length) },
          { label: `${D.plural} בלי מקור`, value: formatNumber(num(totals.without_source)) },
        ],
        sections: [
          {
            title: "לפי מקור ראשון",
            columns: [
              { key: "source", label: "מקור", kind: "text" },
              { key: "deals", label: D.plural, kind: "number" },
              { key: "amount", label: "הכנסה", kind: "money" },
            ],
            rows: bySource.map((r): ReportRow => ({ source: sourceName(r), deals: num(r.deals), amount: num(r.amount) })),
            bar: "amount",
            empty: "לא נסגרו עסקאות בתקופה הזו.",
            note: [
              `${D.singular} ${byGender(D, "משויך", "משויכת")} למקור הראשון של ה${L.singular} שממנו ${byGender(D, "נוצר", "נוצרה")}; אם אין כזה, למקור הראשון של ${terms.contact.theSingular}; ואם גם אין, למקור שנרשם ב${D.singular} ${byGender(D, "עצמו", "עצמה")}.`,
              throughDeal ? `${formatNumber(throughDeal)} ${byGender(D, "מהם", "מהן")} שויכו לפי המקור שב${D.singular}.` : null,
              "המקור האחרון מוצג ברשימות הלידים ואנשי הקשר, ואפשר לסנן לפיו.",
            ]
              .filter(Boolean)
              .join(" "),
          },
          {
            title: "לפי מקור וקמפיין",
            columns: [
              { key: "source", label: "מקור", kind: "text" },
              { key: "campaign", label: "קמפיין", kind: "text" },
              { key: "deals", label: D.plural, kind: "number" },
              { key: "amount", label: "הכנסה", kind: "money" },
            ],
            rows: byCampaign.map((r): ReportRow => ({ source: sourceName(r), campaign: str(r.campaign) ?? "ללא קמפיין", deals: num(r.deals), amount: num(r.amount) })),
            empty: "לא נסגרו עסקאות בתקופה הזו.",
          },
        ],
      };
    }

    // RPT-01: the lines of the deals won in the period, by product and billing (stored line totals)
    case "products": {
      const data = obj(await rpc("report_revenue_by_product", { ...range, p_pipeline: pipelineId, p_owner: ownerId }));
      const totals = obj(data.totals as Json);
      const rows = list(data.by_product as Json);
      const billings = list(data.by_billing as Json);
      const withoutLines = num(totals.deals_without_lines);
      const oneTime = billings.find((b) => b.billing === "one_time");
      // a recurring line's total is one billing period: never added to one-time sales (each kind its own figure)
      const recurring = billings.filter((b) => b.billing !== "one_time");
      return {
        kpis: [
          {
            label: "מכירות חד-פעמיות",
            value: formatMoney(num(oneTime?.amount)),
            hint: `${formatNumber(num(oneTime?.deals))} עסקאות, שורות בחיוב חד-פעמי בלבד`,
          },
          ...recurring.map((b) => ({
            label: billingFigureLabel(str(b.billing)),
            value: formatMoney(num(b.amount)),
            hint: `${formatNumber(num(b.deals))} עסקאות. ${billingFigureHint(str(b.billing))}`,
          })),
          { label: "מוצרים שנמכרו", value: formatNumber(num(totals.products)) },
          {
            label: `${D.plural} בלי שורות`,
            value: formatNumber(withoutLines),
            hint: withoutLines ? `בסך ${formatMoney(num(totals.amount_without_lines))}, לא נספרו כאן` : undefined,
          },
        ],
        sections: [
          {
            title: "לפי מוצר",
            columns: [
              { key: "product", label: "מוצר", kind: "text" },
              { key: "billing", label: "חיוב", kind: "text" },
              { key: "quantity", label: "כמות", kind: "number" },
              { key: "deals", label: D.plural, kind: "number" },
              { key: "amount", label: "סכום", kind: "money" },
            ],
            rows: rows.map(
              (r): ReportRow => ({
                _href: str(r.product_id) ? productPath(orgId, str(r.product_id) as string) : null,
                product: str(r.product_id) ? (str(r.name) ?? "מוצר") : "שורות בלי מוצר",
                billing: billingLabel(str(r.billing)),
                quantity: num(r.quantity),
                deals: num(r.deals),
                amount: num(r.amount),
              }),
            ),
            bar: "amount",
            empty: "לא נמכרו מוצרים בעסקאות שנסגרו בתקופה הזו.",
            note: [
              "נספרות שורות של עסקאות שנסגרו בהצלחה בתקופה, לפי תאריך הסגירה. הסכום הוא סכום השורה כפי שנשמר בעסקה. שורה חודשית, רבעונית או שנתית מוצגת בנפרד, כי הסכום שלה הוא לתקופת חיוב אחת, ולא מתווסף למכירות החד-פעמיות. עסקה בלי שורות לא נספרת כאן; היא מופיעה בדוח \"הכנסות\".",
              vatModeNote(totals),
            ]
              .filter(Boolean)
              .join(" "),
          },
        ],
      };
    }

    // DLI-06: the lines of the deals won in the period, by the category their product is in today
    case "categories": {
      const data = obj(await rpc("report_revenue_by_category", { ...range, p_pipeline: pipelineId, p_owner: ownerId }));
      const totals = obj(data.totals as Json);
      const rows = list(data.by_category as Json);
      const tops = list(data.by_top as Json);
      const billings = list(data.by_billing as Json);
      const withoutLines = num(totals.deals_without_lines);
      const oneTime = billings.find((b) => b.billing === "one_time");
      const recurring = billings.filter((b) => b.billing !== "one_time");
      const categoryName = (r: Record<string, unknown>) =>
        r.kind === "free" ? "שורות בלי מוצר" : r.kind === "uncategorized" ? "מוצרים בלי קטגוריה" : (str(r.name) ?? "קטגוריה");
      const amountNote =
        "נספרות שורות של עסקאות שנסגרו בהצלחה בתקופה, לפי תאריך הסגירה. הסכום הוא סכום השורה כפי שנשמר בעסקה. הקטגוריה היא זו שהמוצר נמצא בה היום. שורה חודשית, רבעונית או שנתית מוצגת בנפרד, כי הסכום שלה הוא לתקופת חיוב אחת.";
      const columns = [
        { key: "category", label: "קטגוריה", kind: "text" as const },
        { key: "billing", label: "חיוב", kind: "text" as const },
        { key: "products", label: "מוצרים", kind: "number" as const },
        { key: "deals", label: D.plural, kind: "number" as const },
        { key: "amount", label: "סכום", kind: "money" as const },
      ];
      return {
        kpis: [
          {
            label: "מכירות חד-פעמיות",
            value: formatMoney(num(oneTime?.amount)),
            hint: `${formatNumber(num(oneTime?.deals))} עסקאות, שורות בחיוב חד-פעמי בלבד`,
          },
          ...recurring.map((b) => ({
            label: billingFigureLabel(str(b.billing)),
            value: formatMoney(num(b.amount)),
            hint: `${formatNumber(num(b.deals))} עסקאות. ${billingFigureHint(str(b.billing))}`,
          })),
          { label: "קטגוריות שנמכרו", value: formatNumber(num(totals.categories)) },
          {
            label: `${D.plural} בלי שורות`,
            value: formatNumber(withoutLines),
            hint: withoutLines ? `בסך ${formatMoney(num(totals.amount_without_lines))}, לא נספרו כאן` : undefined,
          },
        ],
        sections: [
          {
            title: "לפי קטגוריה ראשית",
            columns,
            rows: tops.map((r) => ({ category: str(r.name) ?? "קטגוריה", billing: billingLabel(str(r.billing)), products: num(r.products), deals: num(r.deals), amount: num(r.amount) })),
            bar: "amount",
            empty: "לא נמכרו מוצרים מקטגוריות בעסקאות שנסגרו בתקופה הזו.",
            note: "תת-קטגוריה נספרת בתוך הקטגוריה הראשית שלה.",
          },
          {
            title: "לפי קטגוריה",
            columns,
            rows: rows.map((r) => ({
              category: r.kind === "category" && str(r.parent_name) ? `${str(r.parent_name)} / ${categoryName(r)}` : categoryName(r),
              billing: billingLabel(str(r.billing)),
              products: num(r.products),
              deals: num(r.deals),
              amount: num(r.amount),
            })),
            bar: "amount",
            empty: "לא נמכרו מוצרים בעסקאות שנסגרו בתקופה הזו.",
            note: [amountNote, vatModeNote(totals)].filter(Boolean).join(" "),
          },
        ],
      };
    }

    // DLI-06: gross profit of the won lines that keep a cost, for those who may see costs (the SQL answers nothing otherwise)
    case "profit": {
      const data = obj(await rpc("report_gross_profit", { ...range, p_pipeline: pipelineId, p_owner: ownerId }));
      if (data.allowed !== true) {
        return { kpis: [], sections: [], note: "רק מי שמורשה לראות עלות רואה את הדוח הזה." };
      }
      const totals = obj(data.totals as Json);
      const billings = list(data.by_billing as Json);
      const rows = list(data.by_product as Json);
      const uncosted = num(totals.uncosted_lines);
      const margin = (bp: unknown) => (numOrNull(bp) === null ? null : num(bp) / 100);
      const figure = (b: Record<string, unknown>) =>
        `${formatMoney(num(b.profit))}${numOrNull(b.margin_bp) === null ? "" : ` (${formatCell("percent", margin(b.margin_bp))})`}`;
      const oneTime = billings.find((b) => b.billing === "one_time");
      const recurring = billings.filter((b) => b.billing !== "one_time");
      return {
        kpis: [
          {
            label: "רווח גולמי, חד-פעמי",
            value: oneTime ? figure(oneTime) : formatMoney(0),
            hint: oneTime ? `הכנסה ${formatMoney(num(oneTime.revenue))}, עלות ${formatMoney(num(oneTime.cost))}` : "אין שורות חד-פעמיות עם עלות",
          },
          ...recurring.map((b) => ({
            label: `רווח גולמי, ${billingFigureLabel(str(b.billing))}`,
            value: figure(b),
            hint: `הכנסה ${formatMoney(num(b.revenue))}, עלות ${formatMoney(num(b.cost))}. ${billingFigureHint(str(b.billing))}`,
          })),
          {
            label: "שורות בלי עלות",
            value: formatNumber(uncosted),
            hint: uncosted ? "לא נכללו בחישוב" : undefined,
          },
        ],
        sections: [
          {
            title: "לפי מוצר",
            columns: [
              { key: "product", label: "מוצר", kind: "text" },
              { key: "billing", label: "חיוב", kind: "text" },
              { key: "quantity", label: "כמות", kind: "number" },
              { key: "revenue", label: "הכנסה לפני מע\"מ", kind: "money" },
              { key: "cost", label: "עלות", kind: "money" },
              { key: "profit", label: "רווח גולמי", kind: "money" },
              { key: "margin", label: "שיעור רווח", kind: "percent" },
            ],
            rows: rows.map(
              (r): ReportRow => ({
                _href: str(r.product_id) ? productPath(orgId, str(r.product_id) as string) : null,
                product: str(r.product_id) ? (str(r.name) ?? "מוצר") : "שורות בלי מוצר",
                billing: billingLabel(str(r.billing)),
                quantity: num(r.quantity),
                revenue: num(r.revenue),
                cost: num(r.cost),
                profit: num(r.profit),
                margin: margin(r.margin_bp),
              }),
            ),
            bar: "profit",
            empty: "אין בתקופה הזו שורות עם עלות בעסקאות שנסגרו.",
            note: 'נספרות שורות של עסקאות שנסגרו בהצלחה בתקופה. ההכנסה היא סכום השורה לפני מע"מ, והעלות היא העלות שנשמרה בשורה כפול הכמות. שורה בלי עלות לא נכללת. שורה חודשית, רבעונית או שנתית מוצגת בנפרד, לתקופת חיוב אחת. רק מי שמורשה לראות עלות רואה את הדוח הזה.',
          },
        ],
      };
    }

    // CAL-11: meetings that started in the period, by organizer
    case "meetings": {
      const data = obj(await rpc("report_meetings", { ...range, p_owner: ownerId }));
      const totals = obj(data.totals as Json);
      const byOwner = list(data.by_owner as Json);
      const deals = list(data.deals as Json);
      const name = await ownerNames([...byOwner.map((r) => r.owner_id), ...deals.map((r) => r.owner_id)]);
      const organizer = (id: unknown) => (str(id) ? name(id) : "ללא מארגן");
      const held = num(totals.held);
      const noShow = num(totals.no_show);
      // null (shown as "—") below no_show_min meetings held or missed: the rule is in the SQL
      const minMeetings = num(data.no_show_min);
      const windowDays = num(data.led_window_days);
      // the SQL lists at most 200 deals; won_deals counts them all
      const dealsTotal = num(totals.won_deals);
      const dealsCapped = deals.length < dealsTotal;
      return {
        kpis: [
          { label: "פגישות", value: formatNumber(num(totals.meetings)), hint: `${formatNumber(held)} התקיימו` },
          {
            label: "אחוז אי-הגעה",
            value: formatCell("percent", numOrNull(totals.no_show_rate)),
            hint: `${formatNumber(noShow)} מתוך ${formatNumber(held + noShow)} פגישות שהתקיימו או שהלקוח לא הגיע`,
          },
          {
            label: `פגישות שהובילו ל${D.singular}`,
            value: formatNumber(num(totals.led_meetings)),
            hint: `${formatNumber(num(totals.won_deals))} עסקאות, ${formatMoney(num(totals.won_amount))}`,
          },
        ],
        sections: [
          {
            title: "לפי מארגן",
            columns: [
              { key: "owner", label: "מארגן", kind: "text" },
              { key: "meetings", label: "פגישות", kind: "number" },
              { key: "held", label: "התקיימו", kind: "number" },
              { key: "no_show", label: "הלקוח לא הגיע", kind: "number" },
              { key: "no_show_rate", label: "אחוז אי-הגעה", kind: "percent" },
              { key: "cancelled", label: "בוטלו", kind: "number" },
              { key: "not_updated", label: "עברו ולא עודכנו", kind: "number" },
              { key: "upcoming", label: "עוד לא התקיימו", kind: "number" },
              { key: "led_meetings", label: `הובילו ל${D.singular}`, kind: "number" },
              { key: "won_deals", label: `${D.plural} שנסגרו`, kind: "number" },
              { key: "won_amount", label: "שווי", kind: "money" },
            ],
            rows: byOwner.map((r) => ({
              owner: organizer(r.owner_id),
              meetings: num(r.meetings),
              held: num(r.held),
              no_show: num(r.no_show),
              no_show_rate: numOrNull(r.no_show_rate),
              cancelled: num(r.cancelled),
              not_updated: num(r.not_updated),
              upcoming: num(r.upcoming),
              led_meetings: num(r.led_meetings),
              won_deals: num(r.won_deals),
              won_amount: num(r.won_amount),
            })),
            bar: "meetings",
            empty: "לא נקבעו פגישות בתקופה הזו.",
            note: `נספרות פגישות שמועד תחילתן בתקופה, לפי מי שארגן אותן. אחוז אי-הגעה: מתוך הפגישות שהתקיימו או שהלקוח לא הגיע אליהן; פגישות שבוטלו או שעוד מתוכננות לא נספרות בו. כשיש פחות מ-${formatNumber(minMeetings)} פגישות כאלה, האחוז לא מוצג. עסקה שהיו בה פגישות של שני מארגנים נספרת בשורה של כל אחד מהם, ובסיכום פעם אחת.`,
          },
          {
            // the cap is said in the title, so the CSV and Excel files say it too
            title: dealsCapped
              ? `${D.plural} שנסגרו אחרי פגישה (מוצגות ${formatNumber(deals.length)} האחרונות מתוך ${formatNumber(dealsTotal)})`
              : `${D.plural} שנסגרו אחרי פגישה`,
            columns: [
              { key: "name", label: D.singular, kind: "text" },
              { key: "owner", label: `אחראי ל${D.singular}`, kind: "text" },
              { key: "meetings", label: "פגישות בתקופה", kind: "number" },
              { key: "closed", label: "נסגרה", kind: "text" },
              { key: "amount", label: "שווי", kind: "money" },
            ],
            rows: deals.map(
              (r): ReportRow => ({
                _href: str(r.deal_id) ? paths.deal(orgId, str(r.deal_id) as string) : null,
                name: str(r.name),
                owner: name(r.owner_id),
                meetings: num(r.meetings),
                closed: str(r.closed_at) ? formatDate(str(r.closed_at)) : null,
                amount: num(r.amount),
              }),
            ),
            empty: "אף פגישה בתקופה הזו לא הובילה עדיין לעסקה שנסגרה.",
            note: `פגישה הובילה לעסקה כשהיא התקיימה, ועסקה אחת שנבחרה לה נסגרה בהצלחה בתוך ${formatNumber(windowDays)} ימים מתחילת הפגישה. העסקה נבחרת כך: העסקה שהפגישה מקושרת אליה; אחרת, העסקה שנוצרה בהמרת הליד של הפגישה; אחרת, מבין עסקאות איש הקשר של הפגישה שנוצרו אחרי תחילתה, זו שנסגרה בהצלחה ראשונה. עסקה שנבחרה ולא נסגרה בהצלחה בזמן לא מחליפה עסקה אחרת. כשהליד של הפגישה לא גלוי לך, הבחירה נעשית לפי איש הקשר, ולכן שני משתמשים עשויים לראות תוצאה שונה לאותה פגישה. עסקה נספרת פעם אחת גם כשהיו בה כמה פגישות.`,
          },
        ],
      };
    }

    case "quotes": {
      // QUO-17: quotes sent in the period, each version chain once (its newest sent version); open value is the current state
      const data = parseReportData("report_quotes", await rpc("report_quotes", { ...range, p_owner: ownerId }));
      const t = data.totals;
      const name = await ownerNames(data.by_owner.map((r) => r.owner_id));
      const decided = t.accepted + t.rejected;
      const minutes = (hours: number | null) => (hours === null ? null : Math.round(hours * 60));
      return {
        kpis: [
          { label: "הצעות שנשלחו", value: formatNumber(t.sent), hint: `${formatNumber(t.waiting + t.viewed)} עוד מחכות לתשובה` },
          {
            label: "אחוז אישור",
            value: formatCell("percent", t.acceptance_rate),
            hint: `${formatNumber(t.accepted)} אושרו מתוך ${formatNumber(decided)} שקיבלו תשובה`,
          },
          {
            label: "זמן ממוצע עד אישור",
            value: formatCell("minutes", minutes(t.avg_hours_to_accept)),
            hint: t.accepted_measured > 0 ? `לפי ${formatNumber(t.accepted_measured)} הצעות שאושרו` : undefined,
          },
          { label: "שווי הצעות פתוחות", value: formatMoney(t.open_amount), hint: `${formatNumber(t.open_count)} הצעות פתוחות היום` },
        ],
        sections: [
          {
            title: "לפי סטטוס",
            columns: [
              { key: "status", label: "סטטוס", kind: "text" },
              { key: "quotes", label: "הצעות", kind: "number" },
            ],
            rows: [
              { status: "נשלחה ועוד לא נצפתה", quotes: t.waiting },
              { status: "נצפתה", quotes: t.viewed },
              { status: "אושרה", quotes: t.accepted },
              { status: "נדחתה", quotes: t.rejected },
              { status: "פג תוקפה", quotes: t.expired },
              { status: "בוטלה", quotes: t.cancelled },
            ],
            bar: "quotes",
            empty: "לא נשלחו הצעות מחיר בתקופה הזו.",
          },
          {
            title: "לפי אחראי",
            columns: [
              { key: "owner", label: "אחראי", kind: "text" },
              { key: "sent", label: "נשלחו", kind: "number" },
              { key: "accepted", label: "אושרו", kind: "number" },
              { key: "rejected", label: "נדחו", kind: "number" },
              { key: "acceptance_rate", label: "אחוז אישור", kind: "percent" },
              { key: "accepted_amount", label: "שווי שאושר", kind: "money" },
              { key: "avg_to_accept", label: "זמן ממוצע עד אישור", kind: "minutes" },
              { key: "open_count", label: "פתוחות היום", kind: "number" },
              { key: "open_amount", label: "שווי פתוחות", kind: "money" },
            ],
            rows: data.by_owner.map(
              (r): ReportRow => ({
                owner: name(r.owner_id),
                sent: r.sent,
                accepted: r.accepted,
                rejected: r.rejected,
                acceptance_rate: r.acceptance_rate,
                accepted_amount: r.accepted_amount,
                avg_to_accept: minutes(r.avg_hours_to_accept),
                open_count: r.open_count,
                open_amount: r.open_amount,
              }),
            ),
            bar: "sent",
            empty: "אין הצעות מחיר להצגה.",
            note: `נספרות הצעות שנשלחו בתקופה, לפי מועד השליחה. הצעה שיש לה גרסה חדשה שנשלחה נספרת פעם אחת, לפי הגרסה האחרונה שנשלחה. אחוז אישור: מתוך ההצעות שאושרו או נדחו; כשיש פחות מ-${formatNumber(data.rate_min)} כאלה, האחוז לא מוצג. זמן עד אישור: ממועד השליחה עד שהלקוח אישר. הצעות פתוחות: הצעות שנשלחו או נצפו ועוד לא פג תוקפן, נכון להיום, בלי קשר לתקופה. סכומים כפי שנשמרו בהצעה.`,
          },
        ],
      };
    }

    case "referrals": {
      // CON-06: the relations of the referral type made in the period (RLS: both sides readable); a referrer is a contact or a lead
      const data = obj(await rpc("report_referrals", range));
      const totals = obj(data.totals as Json);
      const rows = list(data.by_referrer as Json);
      return {
        kpis: [
          { label: "הפניות", value: formatNumber(num(totals.referrals)) },
          { label: "מפנים", value: formatNumber(num(totals.referrers)) },
          { label: "הפכו ללקוחות", value: formatNumber(num(totals.customers)) },
          { label: "הכנסה מהם", value: formatMoney(num(totals.won_amount)) },
        ],
        sections: [
          {
            title: "לפי מפנה",
            columns: [
              { key: "referrer", label: "מפנה", kind: "text" },
              { key: "referred", label: "הפנה", kind: "number" },
              { key: "customers", label: "הפכו ללקוחות", kind: "number" },
              { key: "won_amount", label: "הכנסה מהם", kind: "money" },
            ],
            rows: rows.map(
              (r): ReportRow => ({
                _href: str(r.referrer_id)
                  ? r.referrer_kind === "lead"
                    ? paths.lead(orgId, str(r.referrer_id) as string)
                    : paths.contact(orgId, str(r.referrer_id) as string)
                  : null,
                referrer: r.referrer_kind === "lead" ? `${str(r.name) ?? "ליד ללא שם"} (ליד)` : (str(r.name) ?? "איש קשר ללא שם"),
                referred: num(r.referred),
                customers: num(r.customers),
                won_amount: num(r.won_amount),
              }),
            ),
            bar: "referred",
            empty: "לא נרשמו הפניות בתקופה הזו.",
            note:
              "הפניה נספרת כשנרשם בכרטיס איש הקשר או הליד הקשר 'הפנה/תה את' (או השם שנתתם לו בהגדרות), לפי התאריך שבו נרשם. מפנה יכול להיות איש קשר או ליד. לקוח: איש קשר שהופנה ויש לו עסקה שנסגרה בהצלחה אחרי שההפניה נרשמה.",
          },
        ],
      };
    }
  }
  throw new Error(`unknown report ${key}`);
}

