/**
 * HEB-02: a date a person picks (a task's due date) that falls on a day the
 * business does not work. The app warns and offers the next working day; it
 * never refuses the date (a person may still want it).
 */

import { isCalendarDate } from "@/lib/calendar-date";
import { longDay, MONTHS, weekday, WEEKDAYS_LONG } from "@/lib/calendar-grid";

import { nextWorkingDay } from "./business-days";
import { restReason, type CalendarSettings } from "./holidays";

export type RestDayNote = {
  /** Why the business does not work that day, in Hebrew */
  text: string;
  /** The next working day ("YYYY-MM-DD"), or null when none could be found */
  next: string | null;
  /** The button's label, or null without a next working day */
  moveLabel: string | null;
};

/** The note for `day`, or null when the business works that day (or the value is not a date). */
export function restDayNote(day: string, settings: CalendarSettings): RestDayNote | null {
  if (!isCalendarDate(day)) return null;
  const reason = restReason(day, settings);
  if (!reason) return null;
  const text =
    reason.kind === "holiday"
      ? `${reason.holiday.name}: העסק לא עובד ביום הזה.`
      : `יום ${WEEKDAYS_LONG[weekday(day)]} הוא יום מנוחה של העסק.`;
  const next = nextWorkingDay(settings, day);
  return next === day ? { text, next: null, moveLabel: null } : { text, next, moveLabel: `העברה ל${longDay(next)}` };
}

/**
 * The one wording for a date the app moved off a rest day by itself (quick "tomorrow" /
 * "in a week", snooze): "נקבע ליום ראשון, 19 באוקטובר (יום העבודה הבא)" (owner, 14 October 2026).
 * `day` is the moved calendar day, already in the business's zone.
 */
export function movedToWorkingDayNotice(day: string): string {
  return `נקבע ליום ${WEEKDAYS_LONG[weekday(day)]}, ${Number(day.slice(8, 10))} ב${MONTHS[Number(day.slice(5, 7)) - 1]} (יום העבודה הבא)`;
}
