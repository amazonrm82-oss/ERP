import { z } from "zod";

// SGN-03: reminders about a document still unsigned. Pure.
// * Staff (owner (248) ב): org_document_settings.signature_reminder_days N (0 = off, 1..30; default 3) is the interval: a task
//   for the sender N business days after sending, then every N business days, at most SIGNATURE_REMINDERS_MAX times.
// * The customer (owner (249) א): org_document_settings.signature_customer_reminder (default on): one message two calendar
//   days before the document's last day, through the message queue (sent once a provider exists).

export const SIGNATURE_REMINDER_DEFAULT = 3;
export const SIGNATURE_REMINDER_MAX = 30;
export const SIGNATURE_REMINDERS_MAX = 3;
export const SIGNATURE_CUSTOMER_REMINDER_DAYS_BEFORE = 2;

/** The choices the settings form offers. */
export const SIGNATURE_REMINDER_CHOICES: readonly number[] = [0, 1, 2, 3, 4, 5, 7, 10, 14, 21, 30];

export type SignatureReminderSettings = { days: number; customer: boolean };

export function signatureReminderDaysOf(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= SIGNATURE_REMINDER_MAX ? value : SIGNATURE_REMINDER_DEFAULT;
}

export function signatureCustomerReminderOf(value: unknown): boolean {
  return typeof value === "boolean" ? value : true;
}

export function signatureReminderLabel(days: number): string {
  if (days === 0) return "בלי תזכורת";
  if (days === 1) return "כל יום עבודה";
  return `כל ${days} ימי עבודה`;
}

const CHOOSE = "יש לבחור מתי נוצרת התזכורת.";

export const signatureReminderSchema = z.object({
  signature_reminder_days: z.coerce.number({ error: CHOOSE }).int({ error: CHOOSE }).min(0, { error: CHOOSE }).max(SIGNATURE_REMINDER_MAX, { error: CHOOSE }),
  // a checkbox: present = on
  signature_customer_reminder: z.preprocess((value) => value === "on" || value === "true", z.boolean()),
});
