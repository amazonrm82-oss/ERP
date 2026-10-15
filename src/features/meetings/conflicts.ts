// CAL-05: conflicts when a meeting is set, edited or moved. Pure, so it is
// unit-tested; the server part (conflicts-server.ts) reads the data.
//
// A conflict is a warning, never a block: the user may save anyway.
// * Another meeting of the organizer or of a participant that overlaps the
//   time. Cancelled and no-show meetings do not count (the database leaves
//   them out). Back to back (one ends when the other starts) is not a conflict.
//   A meeting the user may not see is named only "another meeting".
//   CAL-08: a meeting type's buffers keep free time around a meeting. The new
//   meeting may not fall into another meeting's buffers, and its own buffers
//   may not fall on another meeting; two buffers may overlap each other.
// * A person outside their working hours (USR-01, in their own time zone, or
//   the organization's when they did not set one). Hours not set: no warning.
// * A rest day or a holiday of the organization (CAL-03).

import { restReason, type CalendarSettings } from "@/features/calendar-days/holidays";
import { WEEKDAYS, type WorkingHours } from "@/features/profile/working-hours";
import { addDays, longDay, weekday } from "@/lib/calendar-grid";
import { zoneDate, zonedIso, zoneTime } from "@/lib/format";

/** A stretch of time; ISO instants, end after start. */
export type Span = { startsAt: string; endsAt: string };

/**
 * One row of public.meeting_busy(): a person is in a meeting at that time.
 * Id and title are null for a meeting the user may not see. busyFrom / busyTo
 * add the meeting type's buffers (CAL-08); absent = the meeting's own times.
 */
export type BusyRow = Span & { userId: string; meetingId: string | null; title: string | null; busyFrom?: string; busyTo?: string };

export type ConflictPerson = {
  userId: string;
  name: string;
  // null: working hours not set
  hours: WorkingHours | null;
  // the zone their working hours are read in
  timeZone: string;
};

export type HoursIssue = "day_off" | "outside";

export type PersonConflict = {
  userId: string;
  name: string;
  // meetings the user may see, by title; `buffer`: only the buffers around one of the two meetings clash (CAL-08)
  meetings: (Span & { meetingId: string; title: string; buffer?: boolean })[];
  // the person has at least one other meeting then that the user may not see
  hidden: boolean;
  hours: HoursIssue | null;
};

// holiday: its name; null for a weekly rest day
export type RestDayIssue = { day: string; holiday: string | null };

export type ConflictReport = { people: PersonConflict[]; restDays: RestDayIssue[] };

/** True when the two overlap; touching ends (back to back) do not. */
export function overlaps(a: Span, b: Span): boolean {
  return Date.parse(a.startsAt) < Date.parse(b.endsAt) && Date.parse(b.startsAt) < Date.parse(a.endsAt);
}

/** The calendar days in the zone that the span has time on (an end at midnight does not touch the next day). */
export function zoneDaysOf(span: Span, timeZone: string): string[] {
  const first = zoneDate(new Date(span.startsAt), timeZone);
  const last = zoneDate(new Date(Date.parse(span.endsAt) - 1), timeZone);
  const days = [first];
  // a meeting is at most 14 days long; the cap only guards a bad input
  for (let day = first; day < last && days.length < 40; ) {
    day = addDays(day, 1);
    days.push(day);
  }
  return days;
}

/**
 * Is the span inside the person's working hours? null when it is (or when the
 * hours are not set), "day_off" when it touches a day they do not work at all,
 * "outside" when part of it falls outside the ranges of their working days.
 * Ranges are read as wall-clock times in the zone, day by day, so a clock
 * change day and a meeting that crosses midnight are judged correctly; ranges
 * that touch (12:00 end, 12:00 start) count as one stretch.
 */
export function workingHoursIssue(span: Span, hours: WorkingHours | null, timeZone: string): HoursIssue | null {
  if (!hours) return null;
  const windows: [number, number][] = [];
  for (const day of zoneDaysOf(span, timeZone)) {
    const ranges = hours[WEEKDAYS[weekday(day)].key];
    if (!ranges || ranges.length === 0) return "day_off";
    for (const range of ranges) {
      const start = Date.parse(zonedIso(day, `${range.start}:00`, timeZone));
      // "23:59" is the end of the day
      const end = range.end === "23:59" ? Date.parse(zonedIso(addDays(day, 1), "00:00:00", timeZone)) : Date.parse(zonedIso(day, `${range.end}:00`, timeZone));
      windows.push([start, end]);
    }
  }
  windows.sort((a, b) => a[0] - b[0]);
  let covered = Date.parse(span.startsAt);
  const end = Date.parse(span.endsAt);
  for (const [start, stop] of windows) {
    if (covered >= end) break;
    if (start > covered) return "outside";
    if (stop > covered) covered = stop;
  }
  return covered >= end ? null : "outside";
}

/** The organization's rest days and holidays the span has time on (in the organization's zone). */
export function restDayIssues(span: Span, settings: CalendarSettings, timeZone: string): RestDayIssue[] {
  const issues: RestDayIssue[] = [];
  for (const day of zoneDaysOf(span, timeZone)) {
    const reason = restReason(day, settings);
    if (!reason) continue;
    issues.push({ day, holiday: reason.kind === "holiday" ? reason.holiday.name : null });
  }
  return issues;
}

type ReportInput = {
  span: Span;
  // the span with the new meeting's own buffers (CAL-08); absent = the span itself
  busySpan?: Span;
  // the organizer first, then the participants; each person once
  people: ConflictPerson[];
  busy: BusyRow[];
  // the meeting being edited or moved, which never clashes with itself
  excludeId?: string | null;
  settings: CalendarSettings;
  timeZone: string;
};

/** Everything to warn about, or null when there is nothing. */
export function conflictReport({ span, busySpan, people, busy, excludeId, settings, timeZone }: ReportInput): ConflictReport | null {
  const taken = busySpan ?? span;
  const seen = new Set<string>();
  const found: PersonConflict[] = [];
  for (const person of people) {
    if (seen.has(person.userId)) continue;
    seen.add(person.userId);
    const ids = new Set<string>();
    const meetings: PersonConflict["meetings"] = [];
    let hidden = false;
    for (const row of busy) {
      // CAL-08: a meeting may not fall into another meeting's buffers, and its own buffers may not
      // fall on another meeting; two buffers may share the same free time
      const rowBusy = { startsAt: row.busyFrom ?? row.startsAt, endsAt: row.busyTo ?? row.endsAt };
      if (row.userId !== person.userId || !(overlaps(rowBusy, span) || overlaps(row, taken))) continue;
      if (row.meetingId === null || row.title === null) {
        hidden = true;
        continue;
      }
      if (row.meetingId === excludeId || ids.has(row.meetingId)) continue;
      ids.add(row.meetingId);
      const buffer = !overlaps(row, span);
      meetings.push({ meetingId: row.meetingId, startsAt: row.startsAt, endsAt: row.endsAt, title: row.title, ...(buffer ? { buffer } : {}) });
    }
    meetings.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.meetingId.localeCompare(b.meetingId));
    const hours = workingHoursIssue(span, person.hours, person.timeZone);
    if (meetings.length > 0 || hidden || hours) found.push({ userId: person.userId, name: person.name, meetings, hidden, hours });
  }
  const restDays = restDayIssues(span, settings, timeZone);
  return found.length > 0 || restDays.length > 0 ? { people: found, restDays } : null;
}

/** One line of the warning; `time` is shown left to right next to the text. */
export type ConflictLine = { key: string; text: string; time: string | null };

/** The warning as short Hebrew lines, times in the organization's zone. */
export function conflictLines(report: ConflictReport, span: Span, timeZone: string): ConflictLine[] {
  const lines: ConflictLine[] = [];
  const spanDay = zoneDate(new Date(span.startsAt), timeZone);
  for (const person of report.people) {
    for (const meeting of person.meetings) {
      const start = new Date(meeting.startsAt);
      const end = new Date(meeting.endsAt);
      const startDay = zoneDate(start, timeZone);
      const endDay = zoneDate(new Date(end.getTime() - 1), timeZone);
      const sameDay = startDay === spanDay && endDay === spanDay;
      lines.push({
        key: `${person.userId}-${meeting.meetingId}`,
        text: `${person.name}: פגישה "${meeting.title}"${sameDay ? "" : `, ${longDay(startDay)}`}${meeting.buffer ? " (במרווח בין הפגישות)" : ""}`,
        time: sameDay ? `${zoneTime(start, timeZone)}–${zoneTime(end, timeZone)}` : null,
      });
    }
    if (person.hidden) {
      lines.push({ key: `${person.userId}-hidden`, text: `${person.name}: יש פגישה אחרת באותו זמן`, time: null });
    }
    if (person.hours === "day_off") {
      lines.push({ key: `${person.userId}-day-off`, text: `${person.name}: יום חופש לפי שעות העבודה`, time: null });
    } else if (person.hours === "outside") {
      lines.push({ key: `${person.userId}-hours`, text: `${person.name}: מחוץ לשעות העבודה`, time: null });
    }
  }
  for (const rest of report.restDays) {
    const what = rest.holiday ? `${rest.holiday}, יום מנוחה בעסק` : "יום מנוחה בעסק";
    lines.push({ key: `rest-${rest.day}`, text: `${longDay(rest.day)}: ${what}`, time: null });
  }
  return lines;
}

export const CONFLICT_MESSAGE = "יש התנגשות בזמן הזה. אפשר לבחור זמן אחר או לקבוע בכל זאת.";
