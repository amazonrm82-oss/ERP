import { nextWorkingDay } from "@/features/calendar-days/business-days";
import type { CalendarSettings } from "@/features/calendar-days/holidays";
import { addDays } from "@/lib/calendar-grid";
import { formatMoney } from "@/lib/format";

// COL-04: collection reminders on a schedule. The job lives in the database (app.send_collection_reminders); this file
// mirrors its rules (app.collection_reminder_offsets, app.collection_reminder_offset, app.collection_reminder_at,
// app.collection_reminder_stage; test 267 compares them day by day) and holds the WhatsApp side of the reminder task. Pure,
// unit tested.

/** Calendar days from the due date: 3 before, the day itself, 7 and 14 after (spec 7.5). */
export const COLLECTION_REMINDER_OFFSETS = [-3, 0, 7, 14] as const;
export type CollectionReminderOffset = (typeof COLLECTION_REMINDER_OFFSETS)[number];

/** How long a reached offset may still be made (a missed run catches up; an old document gets no burst). */
export const COLLECTION_REMINDER_WINDOW_DAYS = 7;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function dayNumber(day: string): number {
  return Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86_400_000;
}

/** The reminder due on `today` for a document due on `due`: the latest offset already reached, for 7 days; else null. */
export function collectionReminderOffset(due: string | null, today: string): CollectionReminderOffset | null {
  if (!due || !DAY.test(due) || !DAY.test(today)) return null;
  const since = dayNumber(today) - dayNumber(due);
  const reached = [...COLLECTION_REMINDER_OFFSETS].reverse().find((offset) => offset <= since);
  return reached !== undefined && since < reached + COLLECTION_REMINDER_WINDOW_DAYS ? reached : null;
}

/**
 * The owner's answer (2) ב of 29 October 2026 (= app.collection_reminder_at): on a WORKING day of the business, the latest
 * offset whose reminder day has come, for 7 days from that day. An offset's reminder day is the calendar day due + offset
 * itself when the business works on it, else its next working day (nextWorkingDay, CAL-03 settings). A rest day makes nothing.
 */
export function collectionReminderAt(
  due: string | null,
  today: string,
  settings: CalendarSettings,
): { offset: CollectionReminderOffset; day: string } | null {
  if (!due || !DAY.test(due) || !DAY.test(today)) return null;
  if (dayNumber(today) < dayNumber(due) - 3) return null;
  if (nextWorkingDay(settings, today) !== today) return null;
  for (const offset of [...COLLECTION_REMINDER_OFFSETS].reverse()) {
    const calendarDay = addDays(due, offset);
    if (calendarDay > today) continue;
    const day = nextWorkingDay(settings, calendarDay);
    if (day > today) continue;
    return dayNumber(today) < dayNumber(day) + COLLECTION_REMINDER_WINDOW_DAYS ? { offset, day } : null;
  }
  return null;
}

/** The stage the task's title names, by the days from the due date to the reminder day (= app.collection_reminder_stage). */
export function collectionReminderStage(days: number): string {
  if (days === 0) return "היום מועד התשלום";
  if (days === -1) return "מחר מועד התשלום";
  if (days === -2) return "בעוד יומיים מועד התשלום";
  if (days < 0) return `בעוד ${-days} ימים מועד התשלום`;
  if (days === 1) return "יום אחרי מועד התשלום";
  if (days === 2) return "יומיים אחרי מועד התשלום";
  return `${days} ימים אחרי מועד התשלום`;
}

/** The stage of each offset when its day was not moved. */
export const COLLECTION_REMINDER_STAGES: Record<CollectionReminderOffset, string> = {
  [-3]: collectionReminderStage(-3),
  0: collectionReminderStage(0),
  7: collectionReminderStage(7),
  14: collectionReminderStage(14),
};

// The owner's wording of 29 October 2026 (answer (3)). Equal to the seeded template of kind 'collection_reminder'
// (app.seed_whatsapp_templates, DEFAULT_TEMPLATES); offered as an unsaved text when the business has no such template (it was
// deleted, or the business was at the 50-template cap or used both names when the template was added to existing businesses).
export const COLLECTION_REMINDER_TEXT =
  "שלום {שם פרטי}, תזכורת: {מסמך} על סך {סכום}, מועד התשלום {מועד תשלום}. אם כבר שילמתם, תודה, ואפשר להתעלם מההודעה. {שם הנציג}, {שם העסק}";

/** "16.11.2026" from "2026-11-16" (a business day, no time zone). */
export function dueDateText(day: string | null): string | null {
  if (!day || !DAY.test(day)) return null;
  return `${Number(day.slice(8, 10))}.${Number(day.slice(5, 7))}.${day.slice(0, 4)}`;
}

/**
 * The amount the message quotes: the document's balance only while the user sees the whole customer's money (BAL-01's rule,
 * as public.customer_debt_summary answers it: allowed and not partial). Otherwise null, so {סכום} stays for the person to
 * complete rather than quote an amount that may be wrong.
 */
export function reminderAmountText(balance: number, summary: { allowed: boolean; partial?: boolean } | null): string | null {
  if (!summary || !summary.allowed || summary.partial !== false || balance <= 0) return null;
  return formatMoney(balance);
}
