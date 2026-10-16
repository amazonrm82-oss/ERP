// TASK-09: the pure parts of "my day" (no database, no clock of its own), so they are unit tested.
//
// "Next action" of a deal means the same as everywhere else (DEAL-02 board, the stuck-deals report,
// REC-10's card summary): an open task linked to the deal (any due date, also overdue), or a planned
// meeting of the deal that has not ended. The database decides it in public.report_stuck_deals()
// (`no_next_step`, security invoker, so RLS decides what counts); this file only reads its rows.

import { formatNumber, zoneDate, zoneTime } from "@/lib/format";

import type { CalendarItem } from "@/features/calendar/queries";

// report_stuck_deals returns at most this many rows (see its `limit`)
export const STUCK_ROWS_LIMIT = 200;

export type DealWithoutNextStep = {
  id: string;
  name: string;
  stageName: string | null;
  // whole days since the last activity (or since the deal was created)
  idleDays: number;
};

export type DealsWithoutNextStep = {
  deals: DealWithoutNextStep[];
  count: number;
  // the function stopped at its limit: there may be more than `count`
  truncated: boolean;
};

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * The deals of report_stuck_deals that have no next action, in the function's order
 * (deals without activity first, then the oldest last activity). `shown` caps the list; `count` counts them all.
 */
export function dealsWithoutNextStep(raw: unknown, shown: number): DealsWithoutNextStep {
  const rows = Array.isArray(raw) ? raw : [];
  const deals: DealWithoutNextStep[] = [];
  for (const item of rows) {
    const row = obj(item);
    if (!row || row.no_next_step !== true || typeof row.id !== "string" || row.id === "") continue;
    const idle = typeof row.idle_days === "number" && Number.isFinite(row.idle_days) ? Math.max(0, Math.floor(row.idle_days)) : 0;
    deals.push({
      id: row.id,
      name: typeof row.name === "string" && row.name.trim() !== "" ? row.name : "עסקה ללא שם",
      stageName: typeof row.stage_name === "string" && row.stage_name !== "" ? row.stage_name : null,
      idleDays: idle,
    });
  }
  return { deals: deals.slice(0, Math.max(0, shown)), count: deals.length, truncated: rows.length >= STUCK_ROWS_LIMIT };
}

/** "פעילות אחרונה היום" / "בלי פעילות יום אחד" / "בלי פעילות 12 ימים". */
export function idleText(days: number): string {
  if (days <= 0) return "פעילות אחרונה היום";
  if (days === 1) return "בלי פעילות יום אחד";
  return `בלי פעילות ${formatNumber(days)} ימים`;
}

export type MyMeeting = Pick<CalendarItem, "id" | "title" | "startsAt" | "status" | "type" | "location" | "related"> & {
  endsAt: string;
  // under way right now / already over
  phase: "upcoming" | "now" | "over";
};

/** Today's meetings of the calendar's items (tasks are listed elsewhere), by start, with where each one stands now. */
export function myMeetings(items: CalendarItem[], now: Date): MyMeeting[] {
  const at = now.getTime();
  return items
    // GAP-07: blocked time is not a meeting to attend
    .filter((item): item is CalendarItem & { endsAt: string } => item.kind === "meeting" && !item.block && item.endsAt !== null)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id))
    .map((item) => ({
      id: item.id,
      title: item.title,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      status: item.status,
      type: item.type,
      location: item.location,
      related: item.related,
      phase: Date.parse(item.endsAt) <= at ? "over" : Date.parse(item.startsAt) <= at ? "now" : "upcoming",
    }));
}

/** The day of an instant as "13.10", for a meeting side that is not today. */
function shortDay(at: Date, timeZone: string): string {
  const day = zoneDate(at, timeZone);
  return `${Number(day.slice(8, 10))}.${Number(day.slice(5, 7))}`;
}

/**
 * "09:00–10:00" in the zone; a side that falls on another day carries its date,
 * as in "12.10 23:00–01:00" for a meeting that began yesterday.
 */
export function meetingSpanText(startsAt: string, endsAt: string, today: string, timeZone: string): string {
  const side = (iso: string) => {
    const at = new Date(iso);
    return zoneDate(at, timeZone) === today ? zoneTime(at, timeZone) : `${shortDay(at, timeZone)} ${zoneTime(at, timeZone)}`;
  };
  return `${side(startsAt)}–${side(endsAt)}`;
}
