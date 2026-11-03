import { SERVICE_MESSAGE_TYPES, type MessageChannel, type MessageType } from "@/features/messaging/providers/types";

import { MERGE_FIELD_PATTERN, MESSAGE_MERGE_FIELDS, type MergeFieldKey } from "./fields";

// MSG-02 follow-up, owner's answer (90) ג (3 November 2026): a SERVICE template is limited to its type's merge fields,
// holds no external link (the system's own links come only through merge fields such as {קישור להצעה}), has a length
// cap, and is checked before every send; one that does not pass is not sent, and the business sees why.
// THE rule is app.message_template_problem(channel, message_type, subject, body) (migration service_template_rule);
// messageTemplateProblem() mirrors it, and both run tests/unit/fixtures/message-template-problems.json (unit test and
// test 291). Saving is never refused: the settings page shows the problem, and the editor warns on save.
// Every future sender (AUT-08, the quote screen, the reminder senders, the OPS-04 message.send path) calls
// assertTemplateSendable() (or app.message_template_sendable in SQL) right before it sends, and never sends on a problem.

export type TemplateProblem = "field_not_allowed" | "external_link" | "too_long";
export type ServiceMessageType = (typeof SERVICE_MESSAGE_TYPES)[number];

const NAMES: readonly MergeFieldKey[] = ["firstName", "fullName", "userName", "businessName", "businessPhone", "businessAddress"];

/** The merge fields each service type may hold (= app.message_type_fields). */
export const SERVICE_TYPE_FIELDS: Record<ServiceMessageType, readonly MergeFieldKey[]> = {
  meeting_reminder: [...NAMES, "date", "time"],
  requested_document: [...NAMES, "document", "quoteLink", "validUntil"],
  collection: [...NAMES, "document", "amount", "dueDate"],
  verification_code: ["businessName", "verificationCode"],
};

/** A service message's body cap by channel, in characters, counted on the template as written (= app.message_service_body_max). */
export const SERVICE_BODY_MAX: Record<MessageChannel, number> = { sms: 300, whatsapp: 1000, email: 2000 };

const EXTERNAL_LINK = /https?:\/\/|www\./i;

function isService(type: MessageType): type is ServiceMessageType {
  return (SERVICE_MESSAGE_TYPES as readonly string[]).includes(type);
}

function fieldName(key: MergeFieldKey): string {
  return MESSAGE_MERGE_FIELDS[key].token.slice(1, -1);
}

export type TemplateText = { channel: MessageChannel; messageType: MessageType; subject: string | null; body: string };

/** Every {field} of the template that its service type may not hold, in order, each once; [] for marketing. */
export function fieldsNotAllowed(template: TemplateText): string[] {
  if (!isService(template.messageType)) return [];
  const allowed = new Set(SERVICE_TYPE_FIELDS[template.messageType].map(fieldName));
  const found = new Set<string>();
  for (const match of `${template.subject ?? ""}\n${template.body}`.matchAll(MERGE_FIELD_PATTERN)) {
    if (!allowed.has(match[1])) found.add(match[0]);
  }
  return [...found];
}

/** null when the template may be sent; else the first problem, in the database's order. Marketing is never judged here. */
export function messageTemplateProblem(template: TemplateText): TemplateProblem | null {
  if (!isService(template.messageType)) return null;
  if (fieldsNotAllowed(template).length > 0) return "field_not_allowed";
  if (EXTERNAL_LINK.test(`${template.subject ?? ""}\n${template.body}`)) return "external_link";
  if ([...template.body].length > SERVICE_BODY_MAX[template.channel]) return "too_long";
  return null;
}

/** Why the template will not be sent, in Hebrew, for the settings page and the editor; null when it may be sent. */
export function templateProblemText(template: TemplateText): string | null {
  const problem = messageTemplateProblem(template);
  if (!problem || !isService(template.messageType)) return null;
  if (problem === "field_not_allowed") {
    const allowed = SERVICE_TYPE_FIELDS[template.messageType].map((key) => MESSAGE_MERGE_FIELDS[key].token).join(" ");
    return `התבנית לא תישלח: בהודעת שירות מהסוג הזה אפשר להשתמש רק בשדות ${allowed}. צריך להוריד את ${fieldsNotAllowed(template).join(", ")}.`;
  }
  if (problem === "external_link") {
    return "התבנית לא תישלח: בהודעת שירות אי אפשר לכתוב קישור. המערכת מוסיפה את הקישורים שלה דרך השדות, למשל {קישור להצעה}.";
  }
  const max = SERVICE_BODY_MAX[template.channel];
  return `התבנית לא תישלח: הודעת שירות בערוץ הזה יכולה להיות עד ${max.toLocaleString("he-IL")} תווים, והנוסח ארוך יותר (${[...template.body].length.toLocaleString("he-IL")}).`;
}

export class TemplateNotSendableError extends Error {
  constructor(readonly problem: TemplateProblem | "inactive") {
    super(`message template is not sendable: ${problem}`);
    this.name = "TemplateNotSendableError";
  }
}

/** For every future sender, right before it sends: throws when the template must not go out (inactive, or a problem). */
export function assertTemplateSendable(template: TemplateText & { isActive: boolean }): void {
  if (!template.isActive) throw new TemplateNotSendableError("inactive");
  const problem = messageTemplateProblem(template);
  if (problem) throw new TemplateNotSendableError(problem);
}
