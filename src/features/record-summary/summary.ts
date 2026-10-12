// REC-10: the summary at the top of a contact or company card. The numbers come
// from public.record_summary() (security invoker, so RLS decides what counts);
// this file turns its JSON into short Hebrew lines. Pure: no database, no clock
// of its own (`now` is passed in), so it is unit tested.

import { LOCALE } from "@/lib/app";
import { zoneDate } from "@/lib/format";

export type DealTotal = { status: "open" | "won"; currency: string; count: number; sum: number };

export type RecordSummaryData = {
  deals: DealTotal[];
  lastTouch: { type: string; occurredAt: string } | null;
  nextTask: { id: string; title: string; taskType: string; dueAt: string | null } | null;
  openTasks: number;
  // the nearest planned meeting that has not ended (RVW-1): a next step too
  nextMeeting: { id: string; title: string; startsAt: string } | null;
};

const TOUCH_LABELS: Record<string, string> = {
  note: "הערה",
  call: "שיחה",
  meeting: "פגישה",
  email: "אימייל",
  whatsapp: "WhatsApp",
  sms: "SMS",
};

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The function's JSON, read defensively: anything missing or malformed counts as "nothing". */
export function parseRecordSummary(raw: unknown): RecordSummaryData {
  const root = obj(raw) ?? {};
  const deals: DealTotal[] = [];
  for (const item of Array.isArray(root.deals) ? root.deals : []) {
    const row = obj(item);
    const status = row?.status;
    const currency = str(row?.currency);
    if (row && (status === "open" || status === "won") && currency) {
      deals.push({ status, currency, count: num(row.count), sum: num(row.sum) });
    }
  }
  const touch = obj(root.last_touch);
  const touchType = str(touch?.type);
  const touchAt = str(touch?.occurred_at);
  const task = obj(root.next_task);
  const taskId = str(task?.id);
  const meeting = obj(root.next_meeting);
  const meetingId = str(meeting?.id);
  const meetingAt = str(meeting?.starts_at);
  return {
    deals,
    lastTouch: touchType && touchAt ? { type: touchType, occurredAt: touchAt } : null,
    nextTask: task && taskId ? { id: taskId, title: str(task.title) ?? "", taskType: str(task.task_type) ?? "todo", dueAt: str(task.due_at) } : null,
    openTasks: num(root.open_tasks),
    nextMeeting: meeting && meetingId && meetingAt ? { id: meetingId, title: str(meeting.title) ?? "", startsAt: meetingAt } : null,
  };
}

/** An amount in agorot in the given currency; whole amounts without ".00". */
export function formatAmount(agorot: number, currency: string): string {
  const value = agorot / 100;
  try {
    return new Intl.NumberFormat(LOCALE, {
      style: "currency",
      currency,
      ...(Number.isInteger(value) ? { maximumFractionDigits: 0 } : {}),
    }).format(value);
  } catch {
    // an unknown currency code: the number and the code
    return `${new Intl.NumberFormat(LOCALE).format(value)} ${currency}`;
  }
}

/** "עסקה אחת" / "3 עסקאות". */
export function dealCountText(count: number): string {
  return count === 1 ? "עסקה אחת" : `${count} עסקאות`;
}

export type DealLine = { count: number; countText: string; amounts: string[] } | null;

/**
 * Open or won deals as one line: the count, and the sum per currency (never added
 * across currencies), the organization's currency first. null when there are none.
 */
export function dealLine(deals: DealTotal[], status: "open" | "won", orgCurrency: string): DealLine {
  const rows = deals.filter((deal) => deal.status === status && deal.count > 0);
  if (rows.length === 0) {
    return null;
  }
  const sums = new Map<string, number>();
  for (const row of rows) {
    sums.set(row.currency, (sums.get(row.currency) ?? 0) + row.sum);
  }
  const currencies = [...sums.keys()].sort((a, b) => (a === orgCurrency ? -1 : b === orgCurrency ? 1 : a.localeCompare(b)));
  const count = rows.reduce((total, row) => total + row.count, 0);
  return { count, countText: dealCountText(count), amounts: currencies.map((currency) => formatAmount(sums.get(currency) ?? 0, currency)) };
}

/** Calendar days between two instants in the zone (0 = same day). */
function calendarDays(from: Date, to: Date, timeZone: string): number {
  return Math.round((Date.parse(zoneDate(to, timeZone)) - Date.parse(zoneDate(from, timeZone))) / 86_400_000);
}

/** "היום" / "אתמול" / "לפני יומיים" / "לפני 5 ימים", by calendar days in the zone. */
export function agoText(iso: string, now: Date, timeZone: string): string {
  const days = calendarDays(new Date(iso), now, timeZone);
  if (days <= 0) return "היום";
  if (days === 1) return "אתמול";
  if (days === 2) return "לפני יומיים";
  return `לפני ${days} ימים`;
}

function dateText(iso: string, timeZone: string, withTime: boolean): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", ...(withTime ? { timeStyle: "short" } : {}), timeZone }).format(date);
}

export type SummaryView = {
  won: DealLine;
  open: DealLine;
  lastTouch: { label: string; ago: string; dateText: string; iso: string } | null;
  nextTask: { title: string; dateText: string | null; iso: string | null; overdue: boolean; moreCount: number } | null;
  nextMeeting: { title: string; dateText: string; iso: string } | null;
};

/** Everything the card shows, in the organization's currency and time zone. */
export function buildSummaryView(data: RecordSummaryData, options: { currency: string; timeZone: string; now: Date }): SummaryView {
  const { currency, timeZone, now } = options;
  const touch = data.lastTouch;
  const task = data.nextTask;
  const meeting = data.nextMeeting;
  return {
    won: dealLine(data.deals, "won", currency),
    open: dealLine(data.deals, "open", currency),
    lastTouch: touch
      ? {
          label: TOUCH_LABELS[touch.type] ?? "פעילות",
          ago: agoText(touch.occurredAt, now, timeZone),
          dateText: dateText(touch.occurredAt, timeZone, false),
          iso: touch.occurredAt,
        }
      : null,
    nextTask: task
      ? {
          title: task.title,
          dateText: task.dueAt ? dateText(task.dueAt, timeZone, true) : null,
          iso: task.dueAt,
          overdue: task.dueAt !== null && Date.parse(task.dueAt) < now.getTime(),
          moreCount: Math.max(0, data.openTasks - 1),
        }
      : null,
    nextMeeting: meeting ? { title: meeting.title, dateText: dateText(meeting.startsAt, timeZone, true), iso: meeting.startsAt } : null,
  };
}
