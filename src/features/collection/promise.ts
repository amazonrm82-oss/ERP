import { z } from "zod";

// COL-03: a payment promise on an open debt document: the date the customer committed to and a collection note. The rules
// live in the database (app.payment_promises_check, app.collection_reminder_held); this file mirrors what the screens need.
// Pure, unit tested.

export const PROMISE_NOTE_MAX = 500;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The rule COL-04's reminders follow (app.collection_reminder_held): a promise holds the document's reminders on every day up
 * to and including the promised date; reminders start again the day after it.
 */
export function reminderHeld(promised: string | null, day: string): boolean {
  return (
    promised !== null && DAY.test(promised) && DAY.test(day) && day <= promised
  );
}

export type PromiseState = "holds" | "broken";

/** A promise whose date passed while the document still owes was not kept ("לא קוימה"). */
export function promiseState(promised: string, today: string): PromiseState {
  return reminderHeld(promised, today) ? "holds" : "broken";
}

/** The last day a person may pick: a year ahead (366 days, the database's limit). */
export function lastPromiseDay(today: string): string {
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 366);
  return date.toISOString().slice(0, 10);
}

export const promiseSchema = z.object({
  promised_date: z.string().regex(DAY, "בחרו תאריך"),
  note: z.string().trim().max(PROMISE_NOTE_MAX, `עד ${PROMISE_NOTE_MAX} תווים`),
});
