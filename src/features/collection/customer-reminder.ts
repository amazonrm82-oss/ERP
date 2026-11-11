import { z } from "zod";

import { COLLECTION_REMINDER_OFFSETS, type CollectionReminderOffset } from "./reminders";

// COL-07 (owner's answers (255)-(258), 11 November 2026): the collection reminders also go to the customer.
// org_document_settings.collection_customer_reminder (default off; owners and admins) and collection_customer_stages (which
// COL-04 stages go to the customer; default the due date, +7 and +14, not 3 days before). A chosen stage queues one message:
// the contact's preferred channel when it is SMS or email and usable, else SMS (with the plan's SMS), else email. The rep's
// task is made only when no message was queued for that stage, and always at the last stage (+14). Nothing is sent for a
// paid, cancelled or promised document, and a message still waiting is cancelled once the debt is settled. The job lives in
// the database (app.send_collection_reminders, app.collection_customer_message). Pure.

export const COLLECTION_CUSTOMER_STAGES_DEFAULT: readonly CollectionReminderOffset[] = [0, 7, 14];

/** The stage that always makes the rep's task, message or not (owner (258) ב). */
export const COLLECTION_TASK_ALWAYS_STAGE: CollectionReminderOffset = 14;

export const COLLECTION_STAGE_LABELS: Record<CollectionReminderOffset, string> = {
  [-3]: "3 ימים לפני מועד התשלום",
  0: "ביום מועד התשלום",
  7: "7 ימים אחרי מועד התשלום",
  14: "14 ימים אחרי מועד התשלום",
};

export type CollectionCustomerReminderSettings = { on: boolean; stages: CollectionReminderOffset[] };

function isOffset(value: unknown): value is CollectionReminderOffset {
  return typeof value === "number" && (COLLECTION_REMINDER_OFFSETS as readonly number[]).includes(value);
}

export function collectionCustomerReminderOf(value: unknown): boolean {
  return value === true;
}

/** The stored stages in COL-04's order; anything else (no row, a bad value) is the default. */
export function collectionCustomerStagesOf(value: unknown): CollectionReminderOffset[] {
  if (!Array.isArray(value) || !value.every(isOffset)) return [...COLLECTION_CUSTOMER_STAGES_DEFAULT];
  return COLLECTION_REMINDER_OFFSETS.filter((offset) => value.includes(offset));
}

export const collectionCustomerReminderSchema = z.object({
  // a checkbox: present = on
  collection_customer_reminder: z.preprocess((value) => value === "on" || value === "true", z.boolean()),
  // checkboxes of one name: the chosen stages
  collection_customer_stages: z.preprocess(
    (value) => (Array.isArray(value) ? value : value == null ? [] : [value]).map((v) => Number(v)),
    z
      .array(z.number().refine(isOffset, { error: "שלב לא מוכר." }))
      .transform((list) => COLLECTION_REMINDER_OFFSETS.filter((offset) => list.includes(offset))),
  ),
});

/** The line shown to whoever cannot change the setting. */
export function collectionCustomerReminderLine(settings: CollectionCustomerReminderSettings): string {
  if (!settings.on) return "תזכורות ללקוח: כבויות.";
  if (settings.stages.length === 0) return "תזכורות ללקוח: פועלות, אבל לא נבחר אף שלב.";
  return `תזכורות ללקוח: ${settings.stages.map((s) => COLLECTION_STAGE_LABELS[s]).join(", ")}.`;
}
