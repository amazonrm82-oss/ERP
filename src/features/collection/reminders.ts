import { formatMoney } from "@/lib/format";

// COL-04: collection reminders on a schedule. The job lives in the database (app.send_collection_reminders); this file
// mirrors its pure rules (app.collection_reminder_offsets, app.collection_reminder_offset, app.collection_reminder_stage;
// test 267 compares them day by day) and holds the WhatsApp side of the reminder task. Pure, unit tested.

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

/** The stage the task's title names (= app.collection_reminder_stage). */
export const COLLECTION_REMINDER_STAGES: Record<CollectionReminderOffset, string> = {
  [-3]: "בעוד 3 ימים מועד התשלום",
  0: "היום מועד התשלום",
  7: "7 ימים אחרי מועד התשלום",
  14: "14 ימים אחרי מועד התשלום",
};

// DRAFT wording (not yet approved by the owner). Equal to the seeded template of kind 'collection_reminder'
// (app.seed_whatsapp_templates, DEFAULT_TEMPLATES); offered as an unsaved text when the business has no such template.
export const COLLECTION_REMINDER_DRAFT_TEXT =
  "שלום {שם פרטי}, תזכורת לתשלום {מסמך} על סך {סכום}, שמועד התשלום שלו {מועד תשלום}. אם כבר שילמת, תודה ואפשר להתעלם מההודעה. {שם הנציג}, {שם העסק}";

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
