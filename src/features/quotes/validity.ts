/**
 * HEB-03 (quote validity): quick choices next to a draft quote's "valid until" date.
 * Business-day choices count working days of the business (CAP-03 rest days and
 * holidays) after the quote's date through addBusinessDays(), the mirror of
 * app.add_business_days(). The calendar-day choice counts plain days and, like
 * HEB-02's quick "in a week", moves a rest day to the next working day and says so.
 * The date field stays the source of truth: a person may still pick any day, and
 * a picked rest day only warns (RestDayWarning).
 */

import { addDays } from "@/lib/calendar-grid";
import { isCalendarDate } from "@/lib/calendar-date";

import { addBusinessDays, nextWorkingDay } from "@/features/calendar-days/business-days";
import type { CalendarSettings } from "@/features/calendar-days/holidays";

export type ValidityChoice = { key: string; days: number; unit: "business" | "calendar"; label: string; ariaLabel: string };

export const VALIDITY_CHOICES: readonly ValidityChoice[] = [
  { key: "b7", days: 7, unit: "business", label: "7 ימי עסקים", ariaLabel: "בתוקף 7 ימי עסקים מתאריך ההצעה" },
  { key: "b14", days: 14, unit: "business", label: "14 ימי עסקים", ariaLabel: "בתוקף 14 ימי עסקים מתאריך ההצעה" },
  { key: "c30", days: 30, unit: "calendar", label: "30 יום", ariaLabel: "בתוקף 30 יום מתאריך ההצעה" },
];

export type ValidityResult = { day: string; moved: boolean };

/** The day counted from: the quote's date, else today (both "YYYY-MM-DD" in the business's zone). */
export function validityStart(quoteDate: string | null | undefined, today: string): string {
  return quoteDate && isCalendarDate(quoteDate) ? quoteDate : today;
}

/**
 * The "valid until" day of a choice counted from `from`, or null when no working
 * day can be found (or the start is not a date). `moved` is true when a calendar
 * choice landed on a rest day and was moved to the next working day.
 */
export function validityDay(settings: CalendarSettings, from: string, choice: Pick<ValidityChoice, "days" | "unit">): ValidityResult | null {
  if (!isCalendarDate(from)) return null;
  if (choice.unit === "business") {
    try {
      return { day: addBusinessDays(settings, from, choice.days), moved: false };
    } catch {
      return null;
    }
  }
  const plain = addDays(from, choice.days);
  const day = nextWorkingDay(settings, plain);
  return { day, moved: day !== plain };
}
