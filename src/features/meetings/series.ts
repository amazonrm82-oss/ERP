import { z } from "zod";

import { addDays, longDay, weekday } from "@/lib/calendar-grid";
import { zoneDate, zoneTime } from "@/lib/format";

import { meetingTimes } from "./schema";

// CAL-09: a recurring meeting, "שבועית, X פעמים". The meetings are made up front, one row each
// (public.create_meeting_series); these are the date rules, pure so they are unit-tested.

// the database refuses other counts (create_meeting_series, constraint meetings_series_shape)
export const SERIES_MIN = 2;
export const SERIES_MAX = 52;
// what the form offers first; the person changes it
export const DEFAULT_SERIES_COUNT = 4;

/** The form's "how many meetings" field: a whole number 2..52. */
export const seriesCountSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z
    .string()
    .regex(/^\d+$/, { error: `יש לכתוב מספר פגישות בין ${SERIES_MIN} ל-${SERIES_MAX}.` })
    .transform(Number)
    .pipe(
      z
        .number()
        .min(SERIES_MIN, { error: `סדרה היא לפחות ${SERIES_MIN} פגישות.` })
        .max(SERIES_MAX, { error: `אפשר עד ${SERIES_MAX} פגישות בסדרה.` }),
    ),
);

/** Which meetings an edit or a cancellation of a series meeting applies to. */
export const SERIES_SCOPES = ["one", "following"] as const;
export type SeriesScope = (typeof SERIES_SCOPES)[number];
export const seriesScopeSchema = z.preprocess((value) => (value === "following" ? "following" : "one"), z.enum(SERIES_SCOPES));

export type SeriesSpan = { starts_at: string; ends_at: string };

/**
 * The times of a weekly series: the same wall-clock times in the organization's zone, on the
 * same weekday, `count` weeks in a row from the first date. Each instant is taken in its own
 * week, so the series keeps its hour across a clock change.
 */
export function weeklySeriesTimes(date: string, startTime: string, endTime: string, timeZone: string, count: number): SeriesSpan[] {
  const times: SeriesSpan[] = [];
  for (let week = 0; week < count; week++) {
    times.push(meetingTimes(addDays(date, week * 7), startTime, endTime, timeZone));
  }
  return times;
}

/** The calendar date of a series' last meeting, for the form's "until" line. */
export function lastSeriesDate(date: string, count: number): string {
  return addDays(date, (Math.max(count, 1) - 1) * 7);
}

/**
 * "This and following" with a new time of day: each following meeting keeps its own date in the
 * organization's zone and takes the new start and end times.
 */
export function shiftToTimes(startsAt: string, startTime: string, endTime: string, timeZone: string): SeriesSpan {
  return meetingTimes(zoneDate(new Date(startsAt), timeZone), startTime, endTime, timeZone);
}

/** The date of a stored meeting in the zone, and whether a form's date moved it to another day. */
export function movesDay(startsAt: string, formDate: string, timeZone: string): boolean {
  return zoneDate(new Date(startsAt), timeZone) !== formDate;
}

/** "פגישה 3 בסדרה" */
export function seriesLabel(index: number): string {
  return `פגישה ${index} בסדרה שבועית`;
}

/** The time of a stored meeting in the zone, "HH:MM". */
export function wallTime(at: string, timeZone: string): string {
  return zoneTime(new Date(at), timeZone);
}

/**
 * CAL-09 (owner, 15 October 2026): moving "this and following" to another weekday splits the series.
 * The new series starts on the nearest date on the new weekday, on or after the chosen meeting's date.
 */
export function splitStartDate(currentDate: string, pickedDate: string): string {
  const shift = (weekday(pickedDate) - weekday(currentDate) + 7) % 7;
  return addDays(currentDate, shift);
}

/**
 * A meeting of the series that someone moved by hand: it is no longer on the date and wall-clock
 * time the weekly rule gives it, counted from the chosen meeting (`base`, index `baseIndex`).
 */
export function movedByHand(
  base: { startsAt: string; index: number },
  meeting: { startsAt: string; index: number },
  timeZone: string,
): boolean {
  const expected = addDays(zoneDate(new Date(base.startsAt), timeZone), (meeting.index - base.index) * 7);
  return zoneDate(new Date(meeting.startsAt), timeZone) !== expected || wallTime(meeting.startsAt, timeZone) !== wallTime(base.startsAt, timeZone);
}

/** The confirmation text of a series split. */
export function splitWarningText(total: number, moved: number, startDay: string): string {
  const head = `הסדרה תועבר: ${total === 1 ? "הפגישה" : `${total} הפגישות`} מהפגישה הזו והלאה יימחקו ויקבעו מחדש כסדרה חדשה, החל מ${startDay}.`;
  const hand = moved === 0 ? "" : moved === 1 ? " פגישה אחת שהוזזה ידנית תימחק." : ` ${moved} פגישות שהוזזו ידנית יימחקו.`;
  return `${head}${hand} פגישות שכבר התקיימו או בוטלו לא משתנות.`;
}

/**
 * CAL-09 (owner, 15 October 2026): a change to "this and following" goes meeting by meeting, by each
 * one's rights, as bulk actions do; the dates that did not change are listed with the reason.
 * The first ten are named (longDay), then "ועוד N".
 */
export function skippedDatesText(dates: readonly string[]): string | null {
  if (dates.length === 0) return null;
  const sorted = [...dates].sort();
  const shown = sorted.slice(0, 10).map(longDay).join("; ");
  const more = sorted.length - 10;
  return `${sorted.length === 1 ? "פגישה אחת לא השתנתה" : `${sorted.length} פגישות לא השתנו`}, אין הרשאה: ${shown}${more > 0 ? `; ועוד ${more}` : ""}.`;
}

/**
 * "מחיקת הפגישה הזו וכל הבאות" (owner, 15 October 2026): the meetings of the series from this one
 * on, in order, leaving out every meeting that has already started.
 */
export function fromHereNotPast<T extends { series_index: number; starts_at: string }>(rows: readonly T[], index: number, now: number): T[] {
  return rows
    .filter((row) => row.series_index >= index && Date.parse(row.starts_at) >= now)
    .sort((a, b) => a.series_index - b.series_index);
}

/** The confirmation text before deleting from this meeting on. */
export function deleteFollowingText(count: number): string {
  const what = count === 1 ? "הפגישה הזו תימחק" : `${count} פגישות יימחקו, מהפגישה הזו ואילך`;
  return `${what}. מחיקה היא לסדרה שנקבעה בטעות; פגישה שפשוט לא תתקיים עדיף לסמן כ״בוטלה״. פגישות שכבר עברו לא נמחקות.`;
}
