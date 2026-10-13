import { z } from "zod";

import { isCalendarDate } from "@/lib/calendar-date";
import { addDays } from "@/lib/calendar-grid";

// A deal postponed with a date (deals.snoozed_until) is not stuck before that day, in the
// organization's time zone (owner's decision, 13 October 2026). The weekly cleanup (MNY-05)
// will set it too; for now the deal page does.

/** Furthest day a deal can be postponed to, from today. */
export const MAX_SNOOZE_DAYS = 365;

/** The form's day: a real day after today and within a year (clearing is a separate button). */
export function snoozeSchema(today: string) {
  return z.object({
    snoozed_until: z
      .string({ message: "בחרו יום." })
      .trim()
      .min(1, { message: "בחרו יום." })
      .refine((value) => isCalendarDate(value), { message: "תאריך לא תקין." })
      .refine((value) => !isCalendarDate(value) || value > today, { message: "בחרו יום אחרי היום." })
      .refine((value) => !isCalendarDate(value) || value <= addDays(today, MAX_SNOOZE_DAYS), {
        message: "אפשר לדחות עד שנה קדימה.",
      }),
  });
}

/** True while the deal is postponed (the day itself counts again, as in report_stuck_deals). */
export function isSnoozed(snoozedUntil: string | null | undefined, today: string): boolean {
  return Boolean(snoozedUntil) && (snoozedUntil as string) > today;
}
