// CAP-09: is a member inside working hours at a moment? Mirrors
// app.member_in_hours() (migration working_hours_leave); keep the two in step.
// tests/db/100-working-hours.test.ts compares them on a grid of cases.
//
// The rule, in order:
// 1. When hours apply (the person's own, else the business's): a rest day or
//    holiday of the business (CAL-03), by its date in the business's time zone,
//    is outside. With no hours set anywhere, rest days do not limit (as before
//    CAP-09; the lead's safe default until the owner decides, review M1).
// 2. A day of leave, by the date in the person's zone (their own, else the
//    business's): outside.
// 3. The person's own weekly hours (profiles.working_hours) in their zone; when
//    they have none, the business's hours (org_calendar_settings.working_hours)
//    in the business's zone; when neither is set, inside. A missing day is a day
//    off; a range runs from its start up to (not including) its end, and a range
//    ending 23:59 runs to midnight.

import { isRestDay, type CalendarSettings } from "@/features/calendar-days/holidays";
import { isTimeZone, WEEKDAYS, type WorkingHours } from "@/features/profile/working-hours";

/** What "set hours" offers a business that has none: 08:00-18:00 (on its working days, workingDaysOnly). */
export const DEFAULT_ORG_HOURS: WorkingHours = Object.fromEntries(
  WEEKDAYS.map(({ key }) => [key, [{ start: "08:00", end: "18:00" }]]),
) as WorkingHours;

export type Leave = { startsOn: string; endsOn: string };

export type HoursInput = {
  at: Date;
  orgTimeZone: string;
  calendar: CalendarSettings;
  // null: the business set no hours (no limit)
  orgHours: WorkingHours | null;
  // null: the business's zone
  userTimeZone: string | null;
  // null: the business's hours apply
  userHours: WorkingHours | null;
  leaves: readonly Leave[];
};

export type OutOfHours = "rest_day" | "leave" | "outside";

const FALLBACK_ZONE = "Asia/Jerusalem";

// app.intake_zone(): an unknown zone reads as Israel
function safeZone(zone: string | null | undefined): string {
  return zone && isTimeZone(zone) ? zone : FALLBACK_ZONE;
}

/** The wall clock in a zone: date "YYYY-MM-DD", weekday 0 = Sunday, time "HH:MM:SS". */
export function wallClock(at: Date, timeZone: string): { date: string; weekday: number; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return { date, weekday: new Date(`${date}T00:00:00Z`).getUTCDay(), time: `${get("hour")}:${get("minute")}:${get("second")}` };
}

/** app.hours_cover(): is the wall-clock moment inside the weekly hours? */
export function hoursCover(hours: WorkingHours, weekday: number, time: string): boolean {
  const ranges = hours[WEEKDAYS[weekday].key];
  if (!ranges) return false;
  return ranges.some((range) => time >= `${range.start}:00` && (range.end === "23:59" || time < `${range.end}:00`));
}

/** Why the member is outside working hours at that moment, or null when inside. */
export function outOfHoursReason(input: HoursInput): OutOfHours | null {
  const orgZone = safeZone(input.orgTimeZone);
  const orgClock = wallClock(input.at, orgZone);
  if ((input.userHours || input.orgHours) && isRestDay(orgClock.date, input.calendar)) return "rest_day";
  const zone = input.userTimeZone === null ? orgZone : safeZone(input.userTimeZone);
  const own = wallClock(input.at, zone);
  if (input.leaves.some((leave) => own.date >= leave.startsOn && own.date <= leave.endsOn)) return "leave";
  if (input.userHours) return hoursCover(input.userHours, own.weekday, own.time) ? null : "outside";
  if (input.orgHours) return hoursCover(input.orgHours, orgClock.weekday, orgClock.time) ? null : "outside";
  return null;
}

/** app.member_in_hours() */
export function memberInHours(input: HoursInput): boolean {
  return outOfHoursReason(input) === null;
}

/** The business's hours on the days it works: where a person's own hours start from. */
export function workingDaysOnly(hours: WorkingHours, calendar: CalendarSettings): WorkingHours {
  return Object.fromEntries(
    WEEKDAYS.filter((_, i) => !(calendar.restWeekdays as number[]).includes(i)).flatMap(({ key }) => (hours[key] ? [[key, hours[key]]] : [])),
  ) as WorkingHours;
}

export const OUT_OF_HOURS_LABELS: Record<OutOfHours, string> = {
  rest_day: "יום מנוחה של העסק",
  leave: "בחופשה",
  outside: "מחוץ לשעות העבודה",
};
