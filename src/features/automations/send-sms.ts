import type { Json } from "@/lib/database.types";

import type { Entity } from "./definitions";

// SMS-02: a step that queues one SMS of the business's SMS template to the rule's record (a lead or a contact; a deal: its
// contact). The engine (app.run_automation_actions -> app.automation_send_sms, migration sms_b_send) reads the template by its
// id within the rule's business when the rule runs and judges it again (SMS channel, sendable, the type, collection's plan
// keys); the message is an OPS-04 job judged by the queue's own checks: a marketing SMS goes only with the customer's SMS
// consent, and nothing goes while customer sending is paused (HEB-09).

/** = errors.ts "feature:sms" (the step and the card refuse without the plan's sms flag). */
export const SMS_NOT_IN_PLAN = "שליחת SMS אינה כלולה בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.";

/** = errors.ts "automation:sms_collection". */
export const SMS_COLLECTION_NEEDS_PAYMENTS =
  "שלב SMS עם תבנית גבייה יכול לשמור רק מי שרושם תשלומים בעסק. בחרו תבנית אחרת או בקשו מבעלי העסק לשמור את הכלל.";

/** The record types a "send SMS" step fits. */
export const SEND_SMS_ENTITIES: readonly Entity[] = ["lead", "contact", "deal"];

/** = 'marketing' + app.record_sms_service_types(): the message types an automation may send as an SMS. */
export const SMS_AUTOMATION_TYPES = ["marketing", "requested_document", "collection"] as const;

type SmsTemplate = { id: string; name: string; messageType: string; isActive: boolean };

/** The templates the builder offers: active ones of an allowed type, plus the step's current one (a saved rule keeps it). */
export function offeredSmsTemplates(templates: readonly SmsTemplate[], current?: string): SmsTemplate[] {
  return templates.filter(
    (t) => ((SMS_AUTOMATION_TYPES as readonly string[]).includes(t.messageType) && t.isActive) || (current !== undefined && current !== "" && t.id === current),
  );
}

/** The builder's "send SMS" values -> the stored action, or a Hebrew message. */
export function sendSmsAction(
  entity: Entity,
  input: { template_id: string },
  lookups: { sms?: boolean; canRecordPayments?: boolean; smsTemplates?: readonly SmsTemplate[] },
): Record<string, Json> | string {
  // review F1: the plan's sms flag (the engine refuses too, 'SMS is not in the plan')
  if (!lookups.sms) return SMS_NOT_IN_PLAN;
  if (!SEND_SMS_ENTITIES.includes(entity)) return "הודעת SMS נשלחת רק לליד, לאיש קשר או לאיש הקשר של עסקה.";
  const template = (lookups.smsTemplates ?? []).find((t) => t.id === input.template_id);
  if (!template || !(SMS_AUTOMATION_TYPES as readonly string[]).includes(template.messageType)) return "התבנית שנבחרה כבר לא קיימת.";
  if (!template.isActive) return "התבנית שנבחרה כבויה. הפעילו אותה במסך תבניות ההודעה או בחרו אחרת.";
  // review (2): a collection step only for a payment recorder (= trigger automations_sms_collection, hint automation:sms_collection)
  if (template.messageType === "collection" && !lookups.canRecordPayments) return SMS_COLLECTION_NEEDS_PAYMENTS;
  return { type: "send_sms", template_id: input.template_id };
}

/** A stored "send SMS" action -> the builder's values. */
export function sendSmsDraft(action: Record<string, unknown>): Record<string, string> {
  return { type: "send_sms", template_id: typeof action.template_id === "string" ? action.template_id : "" };
}

/** `"<template>"` for a rule's description. */
export function describeSendSms(action: Record<string, unknown>, lookups: { smsTemplates?: readonly SmsTemplate[] }): string {
  const name = (lookups.smsTemplates ?? []).find((t) => t.id === action.template_id)?.name;
  return name ? `"${name}"` : "תבנית שנמחקה";
}
