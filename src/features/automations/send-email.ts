import type { Json } from "@/lib/database.types";

import type { Entity } from "./definitions";

// AUT-08: a step that queues one email of the business's email template to the rule's record (a lead or a contact; a deal:
// its contact), with the rules of the SMS step (send-sms.ts). The engine (app.run_automation_actions ->
// app.automation_send_email, migration automation_send_email) reads the template by its id within the rule's business when
// the rule runs and judges it again (email channel, sendable, the type, collection's plan keys and, on a button press, the
// presser's payments right); the message is an OPS-04 job judged by the queue's own checks: a marketing email goes only with
// the customer's email consent, and nothing goes while customer sending is paused (HEB-09). No attachments: record and
// library files are a person's choice on the card only.

/** = errors.ts "automation:email_collection". */
export const EMAIL_COLLECTION_NEEDS_PAYMENTS =
  "שלב אימייל עם תבנית גבייה יכול לשמור רק מי שרושם תשלומים בעסק. בחרו תבנית אחרת או בקשו מבעלי העסק לשמור את הכלל.";

/** The record types a "send email" step fits. */
export const SEND_EMAIL_ENTITIES: readonly Entity[] = ["lead", "contact", "deal"];

/** = 'marketing' + app.record_email_service_types(): the message types an automation may send as an email. */
export const EMAIL_AUTOMATION_TYPES = ["marketing", "requested_document", "collection"] as const;

type EmailTemplate = { id: string; name: string; messageType: string; isActive: boolean };

/** The templates the builder offers: active ones of an allowed type, plus the step's current one (a saved rule keeps it). */
export function offeredEmailTemplates(templates: readonly EmailTemplate[], current?: string): EmailTemplate[] {
  return templates.filter(
    (t) => ((EMAIL_AUTOMATION_TYPES as readonly string[]).includes(t.messageType) && t.isActive) || (current !== undefined && current !== "" && t.id === current),
  );
}

/** The builder's "send email" values -> the stored action, or a Hebrew message. */
export function sendEmailAction(
  entity: Entity,
  input: { template_id: string },
  lookups: { canRecordPayments?: boolean; emailTemplates?: readonly EmailTemplate[] },
): Record<string, Json> | string {
  if (!SEND_EMAIL_ENTITIES.includes(entity)) return "הודעת אימייל נשלחת רק לליד, לאיש קשר או לאיש הקשר של עסקה.";
  const template = (lookups.emailTemplates ?? []).find((t) => t.id === input.template_id);
  if (!template || !(EMAIL_AUTOMATION_TYPES as readonly string[]).includes(template.messageType)) return "התבנית שנבחרה כבר לא קיימת.";
  if (!template.isActive) return "התבנית שנבחרה כבויה. הפעילו אותה במסך תבניות ההודעה או בחרו אחרת.";
  // a collection step only for a payment recorder (= trigger automations_sms_collection, hint automation:email_collection)
  if (template.messageType === "collection" && !lookups.canRecordPayments) return EMAIL_COLLECTION_NEEDS_PAYMENTS;
  return { type: "send_email", template_id: input.template_id };
}

/** A stored "send email" action -> the builder's values. */
export function sendEmailDraft(action: Record<string, unknown>): Record<string, string> {
  return { type: "send_email", template_id: typeof action.template_id === "string" ? action.template_id : "" };
}

/** `"<template>"` for a rule's description. */
export function describeSendEmail(action: Record<string, unknown>, lookups: { emailTemplates?: readonly EmailTemplate[] }): string {
  const name = (lookups.emailTemplates ?? []).find((t) => t.id === action.template_id)?.name;
  return name ? `"${name}"` : "תבנית שנמחקה";
}
