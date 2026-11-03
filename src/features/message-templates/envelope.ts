import type { MessageChannel, MessageType } from "@/features/messaging/providers/types";

// MSG-02 (owner 3 November 2026, answer (88)): what the SYSTEM adds to every marketing message, whatever the template
// says, so a business cannot remove it: the word "פרסומת" in front (the subject of an email; the text itself on a channel
// without a subject), the sender line (name, phone, address) and the unsubscribe line. Pure, so every future sender
// (AUT-08, campaigns, the provider adapters) calls the same function before filling the merge fields; the settings
// page's preview uses it now. A service message is returned unchanged. DRAFT wording until the lawyer approves it.
//
// Doubling: a template may already hold these parts. "פרסומת" is not put in front twice when the subject (or the text)
// already starts with it; the sender line is not added when the body already holds that exact line; the unsubscribe line
// is not added when the body already holds {קישור הסרה} (the link is what matters, wherever the business put it). So a
// business may write them itself but can never end up without them.

export const MARKETING_PREFIX = "פרסומת: ";
export const MARKETING_SENDER_LINE = "{שם העסק} · {טלפון העסק} · {כתובת העסק}";
export const MARKETING_UNSUBSCRIBE_TOKEN = "{קישור הסרה}";
export const MARKETING_UNSUBSCRIBE_LINE = `להסרה מרשימת התפוצה: ${MARKETING_UNSUBSCRIBE_TOKEN}`;

export type EnvelopeInput = { channel: MessageChannel; messageType: MessageType; subject: string | null; body: string };
export type EnvelopeOutput = { subject: string | null; body: string };

const PREFIX_WORD = MARKETING_PREFIX.trim().replace(/:$/, "");

function withPrefix(text: string): string {
  const trimmed = text.trimStart();
  return trimmed.startsWith(PREFIX_WORD) ? text : `${MARKETING_PREFIX}${trimmed}`;
}

/** The message as it must go out: unchanged for a service type; for marketing, with the parts the system adds. */
export function marketingEnvelope(message: EnvelopeInput): EnvelopeOutput {
  if (message.messageType !== "marketing") return { subject: message.subject, body: message.body };
  const hasSubject = message.channel === "email";
  const subject = hasSubject ? withPrefix(message.subject ?? "") : message.subject;
  let body = hasSubject ? message.body : withPrefix(message.body);
  const tail: string[] = [];
  if (!body.split("\n").some((line) => line.trim() === MARKETING_SENDER_LINE)) tail.push(MARKETING_SENDER_LINE);
  if (!body.includes(MARKETING_UNSUBSCRIBE_TOKEN)) tail.push(MARKETING_UNSUBSCRIBE_LINE);
  if (tail.length > 0) body = `${body.trimEnd()}\n\n${tail.join("\n")}`;
  return { subject, body };
}

/** The business's address as one line ("רחוב 1, עיר"), or null. */
export function businessAddressLine(details: { addressLine: string | null; city: string | null }): string | null {
  const parts = [details.addressLine, details.city].map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(", ") : null;
}
