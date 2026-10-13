/**
 * Business-day arithmetic (HEB-03): "in 3 business days" for tasks, automations,
 * and later quote validity and payment due dates.
 *
 * Mirrors app.add_business_days() (migration business_days); a database test
 * compares the two day by day for several settings. A working day is a day that
 * is not a rest day of the business (isRestDay(), CAL-03 settings).
 *
 * Days are "YYYY-MM-DD" calendar days, as in calendar-grid.
 */

import { addDays } from "@/lib/calendar-grid";
import { isCalendarDate } from "@/lib/calendar-date";

import { isRestDay, type CalendarSettings } from "./holidays";

/** The most business days one call counts (the database refuses more: hint business_days:range). */
export const MAX_BUSINESS_DAYS = 1000;

/** The longest run of days off searched before giving up (hint business_days:no_working_day). */
export const MAX_DAYS_OFF_IN_A_ROW = 366;

/** The quick choices next to a task's due date, and the free number's range. */
export const BUSINESS_DAY_CHOICES = [1, 2, 3, 5, 10] as const;
export const BUSINESS_DAYS_FREE_MAX = 60;

export class BusinessDaysError extends Error {
  constructor(readonly hint: "business_days:range" | "business_days:no_working_day" | "business_days:date") {
    super(hint);
    this.name = "BusinessDaysError";
  }
}

/**
 * The day `n` working days after `from`. n = 0: `from` itself when it is a
 * working day, else the next working day. Throws BusinessDaysError for a
 * negative or non-integer n, n over MAX_BUSINESS_DAYS, a bad date, or when no
 * working day comes within MAX_DAYS_OFF_IN_A_ROW days.
 */
export function addBusinessDays(settings: CalendarSettings, from: string, n: number): string {
  if (!isCalendarDate(from)) throw new BusinessDaysError("business_days:date");
  if (!Number.isInteger(n) || n < 0 || n > MAX_BUSINESS_DAYS) throw new BusinessDaysError("business_days:range");

  let day = from;
  let off = 0;
  let left = n;
  if (left > 0) {
    day = addDays(day, 1);
  }
  for (;;) {
    if (isRestDay(day, settings)) {
      off += 1;
      if (off > MAX_DAYS_OFF_IN_A_ROW) throw new BusinessDaysError("business_days:no_working_day");
    } else {
      off = 0;
      if (left <= 1) return day;
      left -= 1;
    }
    day = addDays(day, 1);
  }
}

/**
 * HEB-02: `day` itself when the business works on it, else the next working day
 * (addBusinessDays with n = 0, the same as app.add_business_days(org, day, 0)).
 * A day for which no working day can be found stays as it is.
 */
export function nextWorkingDay(settings: CalendarSettings, day: string): string {
  try {
    return addBusinessDays(settings, day, 0);
  } catch {
    return day;
  }
}

/** The free number of business days typed by a user: a whole number 1..BUSINESS_DAYS_FREE_MAX, else null. */
export function parseBusinessDays(value: string): number | null {
  const text = value.trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= BUSINESS_DAYS_FREE_MAX ? n : null;
}
