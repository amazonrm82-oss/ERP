import { addDays, addMonths, longDay, monthGrid, monthTitle, MONTHS, startOfWeek } from "@/lib/calendar-grid";
import { isCalendarDate } from "@/lib/calendar-date";
import { zoneDate, zonedIso, zoneTime } from "@/lib/format";

// CAL-02: the date math of the calendar screen. Days are "YYYY-MM-DD" in the
// organization's zone; instants are UTC ISO strings. Pure, so it is unit-tested
// and runs the same on the server and in the browser.

export const CALENDAR_VIEWS = ["day", "week", "month", "agenda"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export const VIEW_LABEL: Record<CalendarView, string> = { day: "יום", week: "שבוע", month: "חודש", agenda: "סדר יום" };

// the agenda lists this many days from the chosen one
export const AGENDA_DAYS = 14;
// grid positions snap to a quarter of an hour
export const SNAP_MINUTES = 15;
// a task is a point in time; on the time grid it takes half an hour
export const TASK_MINUTES = 30;
const DAY_MINUTES = 24 * 60;

/** The view from the URL; null when it is missing or unknown (the page picks a default). */
export function parseView(value: string | undefined): CalendarView | null {
  return CALENDAR_VIEWS.find((view) => view === value) ?? null;
}

/** The day from the URL, or today when it is missing or not a real day. */
export function parseDay(value: string | undefined, today: string): string {
  return value && isCalendarDate(value) ? value : today;
}

/** The days a view shows, first to last. A month shows whole weeks, Sunday to Saturday. */
export function viewDays(view: CalendarView, day: string): string[] {
  switch (view) {
    case "day":
      return [day];
    case "week": {
      const first = startOfWeek(day);
      return Array.from({ length: 7 }, (_, i) => addDays(first, i));
    }
    case "month":
      return monthGrid(day).flat();
    case "agenda":
      return Array.from({ length: AGENDA_DAYS }, (_, i) => addDays(day, i));
  }
}

/** The day "previous" (-1) or "next" (1) moves to. */
export function stepDay(view: CalendarView, day: string, direction: 1 | -1): string {
  switch (view) {
    case "day":
      return addDays(day, direction);
    case "week":
      return addDays(day, 7 * direction);
    case "month":
      return addMonths(day, direction);
    case "agenda":
      return addDays(day, AGENDA_DAYS * direction);
  }
}

/** UTC instants from the start of the first day to the start of the day after the last, in the zone. */
export function rangeBounds(days: string[], timeZone: string): { from: string; to: string } {
  return { from: zonedIso(days[0], "00:00", timeZone), to: zonedIso(addDays(days[days.length - 1], 1), "00:00", timeZone) };
}

function dayMonth(day: string): string {
  return `${Number(day.slice(8, 10))} ב${MONTHS[Number(day.slice(5, 7)) - 1]}`;
}

/** "11–17 באוקטובר 2026", "27 בספטמבר – 3 באוקטובר 2026", "28 בדצמבר 2026 – 3 בינואר 2027". */
export function spanTitle(first: string, last: string): string {
  if (first.slice(0, 4) !== last.slice(0, 4)) {
    return `${dayMonth(first)} ${first.slice(0, 4)} – ${dayMonth(last)} ${last.slice(0, 4)}`;
  }
  if (first.slice(0, 7) !== last.slice(0, 7)) {
    return `${dayMonth(first)} – ${dayMonth(last)} ${last.slice(0, 4)}`;
  }
  return `${Number(first.slice(8, 10))}–${dayMonth(last)} ${last.slice(0, 4)}`;
}

/** The heading of a view. */
export function viewTitle(view: CalendarView, day: string): string {
  if (view === "day") return longDay(day);
  if (view === "month") return monthTitle(day);
  const days = viewDays(view, day);
  return spanTitle(days[0], days[days.length - 1]);
}

// --- Items on days -------------------------------------------------------------

export type TimedItem = {
  id: string;
  kind: "meeting" | "task";
  // a meeting's start, a task's due time
  startsAt: string;
  // a meeting's end; null for a task
  endsAt: string | null;
};

/** Minutes after midnight of an instant's wall-clock time in the zone (23:30 → 1410). */
export function wallMinutes(at: Date, timeZone: string): number {
  const [h, m] = zoneTime(at, timeZone).split(":").map(Number);
  return h * 60 + m;
}

/** "HH:MM" of minutes after midnight. */
export function minutesToTime(minutes: number): string {
  const m = Math.max(0, Math.min(DAY_MINUTES - 1, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** True when the item is on the day: a meeting that overlaps it, a task due on it. */
export function isOnDay(item: TimedItem, day: string, timeZone: string): boolean {
  const start = Date.parse(item.startsAt);
  if (item.endsAt === null) {
    return zoneDate(new Date(start), timeZone) === day;
  }
  const dayStart = Date.parse(zonedIso(day, "00:00", timeZone));
  const dayEnd = Date.parse(zonedIso(addDays(day, 1), "00:00", timeZone));
  const end = Date.parse(item.endsAt);
  return start < dayEnd && end > dayStart;
}

/** The items on a day, by start time (a meeting that began earlier comes first). */
export function itemsOnDay<T extends TimedItem>(items: T[], day: string, timeZone: string): T[] {
  return items.filter((item) => isOnDay(item, day, timeZone)).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id));
}

export type Segment<T extends TimedItem = TimedItem> = {
  item: T;
  // wall-clock minutes on this day, end exclusive
  startMin: number;
  endMin: number;
  // false when the item began on an earlier day (a continuation of a long meeting)
  startsHere: boolean;
  // side-by-side columns for items at the same time
  column: number;
  columns: number;
};

/**
 * Where each item of a day sits on the time grid. Positions are wall-clock
 * minutes, so on a clock-change day 10:00 is still drawn at 10:00. Overlapping
 * items share the width in columns.
 */
export function daySegments<T extends TimedItem>(items: T[], day: string, timeZone: string): Segment<T>[] {
  const dayStart = Date.parse(zonedIso(day, "00:00", timeZone));
  const dayEnd = Date.parse(zonedIso(addDays(day, 1), "00:00", timeZone));
  const raw = itemsOnDay(items, day, timeZone).map((item) => {
    const start = Date.parse(item.startsAt);
    const startsHere = start >= dayStart;
    const startMin = startsHere ? wallMinutes(new Date(start), timeZone) : 0;
    let endMin: number;
    if (item.endsAt === null) {
      endMin = Math.min(DAY_MINUTES, startMin + TASK_MINUTES);
    } else {
      const end = Date.parse(item.endsAt);
      endMin = end >= dayEnd ? DAY_MINUTES : wallMinutes(new Date(end), timeZone);
      // a meeting shorter than a quarter of an hour still gets room for its title
      endMin = Math.min(DAY_MINUTES, Math.max(endMin, startMin + SNAP_MINUTES));
    }
    return { item, startMin, endMin, startsHere, column: 0, columns: 1 };
  });
  return layoutColumns(raw);
}

/**
 * Side-by-side columns: items that overlap get different columns, and every
 * item of one overlapping group gets the group's column count.
 */
export function layoutColumns<S extends { startMin: number; endMin: number; column: number; columns: number }>(segments: S[]): S[] {
  const sorted = [...segments].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  let group: S[] = [];
  let groupEnd = -1;
  let ends: number[] = [];
  const close = () => {
    for (const s of group) s.columns = ends.length;
    group = [];
    ends = [];
  };
  for (const segment of sorted) {
    if (segment.startMin >= groupEnd && group.length > 0) close();
    let column = ends.findIndex((end) => end <= segment.startMin);
    if (column === -1) {
      column = ends.length;
      ends.push(segment.endMin);
    } else {
      ends[column] = segment.endMin;
    }
    segment.column = column;
    group.push(segment);
    groupEnd = Math.max(groupEnd, segment.endMin);
  }
  close();
  return sorted;
}

/** Minutes after midnight for a point `offset` pixels down a day column `height` pixels tall, snapped. */
export function snapMinutes(offset: number, height: number): number {
  if (height <= 0) return 0;
  const raw = (offset / height) * DAY_MINUTES;
  const snapped = Math.round(raw / SNAP_MINUTES) * SNAP_MINUTES;
  return Math.max(0, Math.min(DAY_MINUTES - SNAP_MINUTES, snapped));
}

/** A meeting's new end when its start moves, keeping its length. */
export function movedEnd(startsAt: string, endsAt: string, newStart: string): string {
  return new Date(Date.parse(newStart) + (Date.parse(endsAt) - Date.parse(startsAt))).toISOString();
}

// --- Address -------------------------------------------------------------------

/** The calendar screen; `view`, `date` and `who` travel in the query string. */
export function calendarPath(orgId: string, query?: { view?: CalendarView; date?: string; who?: string }): string {
  const base = `/o/${orgId}/calendar`;
  if (!query) return base;
  const params = new URLSearchParams();
  if (query.view) params.set("view", query.view);
  if (query.date) params.set("date", query.date);
  if (query.who) params.set("who", query.who);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}
