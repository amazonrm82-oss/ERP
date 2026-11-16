// QUO-18, the reminders (owner's answers (381) ב, (382) א, (383) א, (384) ב; migration quote_reminders): automatic reminders to
// the customer about a sent quote. The database decides everything (app.send_quote_reminders, app.quote_reminder_stage); these
// are the settings page's texts and the DRAFT templates the job seeds (= app.seed_quote_reminder_templates; the unit test reads
// the migration).

import { z } from "zod";

/** The plan key (384) ב: basic and up. */
export const QUOTE_REMINDERS_FEATURE = "quote_reminders";

/** The business days after sending of the two reminders to a customer who did not open the quote (381) ב. */
export const UNOPENED_REMINDER_BUSINESS_DAYS = [3, 7] as const;

/** The calendar days before the last day of validity of the reminder to a customer who opened it (382) א. */
export const EXPIRING_REMINDER_DAYS = 2;

export const quoteReminderSchema = z.object({
  quote_customer_reminder: z.preprocess((value) => value === "on" || value === "true", z.boolean()),
});

/** A stored switch, read defensively: anything but true is off (383) א. */
export function quoteCustomerReminderOf(value: unknown): boolean {
  return value === true;
}

// DRAFT wording until the lawyer edits it
export const DEFAULT_QUOTE_REMINDER_TEMPLATES = [
  {
    name: "הצעת מחיר: תזכורת (אימייל)",
    channel: "email",
    subject: "תזכורת: הצעת המחיר מ{שם העסק}",
    body: "שלום {שם פרטי},\n\nרצינו להזכיר שהצעת המחיר מחכה לך כאן: {קישור להצעה}{ ההצעה בתוקף עד {תוקף}.}\n\n{שם הנציג}, {שם העסק}",
  },
  {
    name: "הצעת מחיר: תזכורת (SMS)",
    channel: "sms",
    subject: null,
    body: "שלום {שם פרטי}, תזכורת: הצעת המחיר מ{שם העסק} מחכה לך כאן: {קישור להצעה}{ בתוקף עד {תוקף}}. {שם העסק}",
  },
] as const;
