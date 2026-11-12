// MNY-06: "what the system did for you this month". Pure: which month to show and the card's lines, from
// public.report_monthly_summary (counts only, never a name). Owner (273): every plan.

import type { OrgTerms } from "@/features/terminology/terms";
import type { ReportData } from "@/features/reports/schemas";

export type MonthlySummary = Extract<ReportData<"report_monthly_summary">, { allowed: true }>;

export type SummaryLine = { key: string; label: string; value: number; note: string | null };

/** The first day of a month from `?month=YYYY-MM`, only this month or an earlier one (null = this month). */
export function summaryMonth(raw: string | string[] | undefined, today: string): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return null;
  const month = `${value}-01`;
  return month <= `${today.slice(0, 7)}-01` && month >= "2000-01-01" ? month : null;
}

/** The month before a month's first day, as `YYYY-MM`. */
export function previousMonth(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return m === 1 ? `${year - 1}-12` : `${year}-${String(m - 1).padStart(2, "0")}`;
}

/** The month after, as `YYYY-MM`, or null when the month shown is the current one. */
export function nextMonth(month: string, today: string): string | null {
  const [year, m] = month.split("-").map(Number);
  const next = m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, "0")}`;
  return `${next}-01` <= `${today.slice(0, 7)}-01` ? next : null;
}

const MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];

/** "נובמבר 2026" */
export function monthLabel(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return `${MONTHS[m - 1]} ${year}`;
}

export const SUMMARY_TIMEOUT_MESSAGE = "הסיכום החודשי לא נטען: יש יותר מדי רשומות לספור כרגע. שאר הדוחות זמינים.";
export const SUMMARY_FAILED_MESSAGE = "הסיכום החודשי לא נטען כרגע. נסו שוב בעוד כמה דקות. שאר הדוחות זמינים.";

/** The Hebrew line for a failed read of the monthly summary (a statement timeout, or anything else). */
export function summaryLoadMessage(error: { code?: string | null } | null | undefined): string {
  return error?.code === "57014" ? SUMMARY_TIMEOUT_MESSAGE : SUMMARY_FAILED_MESSAGE;
}

/** The card's lines: only what happened (a zero line is left out). */
export function summaryLines(data: MonthlySummary, terms: OrgTerms, formatNumber: (n: number) => string): SummaryLine[] {
  const sentNote = (sent: number) => (sent > 0 ? `נשלחו ${formatNumber(sent)}` : null);
  const lines: SummaryLine[] = [
    { key: "leads", label: `${terms.lead.plural} שחולקו אוטומטית`, value: data.leads_distributed, note: null },
    { key: "automation_tasks", label: "משימות שאוטומציות יצרו", value: data.automation_tasks, note: null },
    { key: "collection_tasks", label: "תזכורות גבייה לצוות", value: data.reminder_tasks.collection, note: null },
    { key: "signature_tasks", label: "תזכורות על מסמכים שמחכים לחתימה", value: data.reminder_tasks.signature, note: null },
    { key: "renewal_tasks", label: "תזכורות לחידוש חוזה", value: data.reminder_tasks.contract_renewal, note: null },
    {
      key: "collection_messages",
      label: "תזכורות תשלום ללקוחות",
      value: data.customer_messages.collection.queued,
      note: sentNote(data.customer_messages.collection.sent),
    },
    {
      key: "meeting_messages",
      label: "תזכורות פגישה ללקוחות",
      value: data.customer_messages.meeting_reminder.queued,
      note: sentNote(data.customer_messages.meeting_reminder.sent),
    },
    {
      key: "instant_replies",
      label: "מענה מיידי לפניות",
      value: data.customer_messages.instant_reply.queued,
      note: sentNote(data.customer_messages.instant_reply.sent),
    },
    {
      key: "review_requests",
      label: "בקשות ביקורת",
      value: data.customer_messages.review_request.queued,
      note: sentNote(data.customer_messages.review_request.sent),
    },
    {
      key: "collected",
      label: `חובות ששולמו עד ${formatNumber(data.collected_after_reminder.window_days)} יום אחרי תזכורת`,
      value: data.collected_after_reminder.documents,
      note:
        data.collected_after_reminder.payments === 1
          ? "בתשלום אחד"
          : `ב-${formatNumber(data.collected_after_reminder.payments)} תשלומים`,
    },
  ];
  return lines.filter((line) => line.value > 0);
}
