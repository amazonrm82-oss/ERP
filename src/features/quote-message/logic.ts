// QUO-18 (owner's answer (89) א): a sent quote to its customer by email or SMS, from the quote screen only, to the customer
// address on the quote, from a requested_document template. It is queued as an OPS-04 message.send job by
// public.quote_message_send (migration quote_message_send), which judges everything again; these are the dialog's own rules and
// texts, kept equal to the database's (tests/unit/quote-message.test.ts reads the migration).

import { cardUnfillableFields } from "@/features/message-templates/card-fields";
import { fillMessage, OPTIONAL_PART_PATTERN, unfilledMergeFields, type MergeValues } from "@/features/message-templates/fields";

export const QUOTE_MESSAGE_CHANNELS = ["email", "sms"] as const;
export type QuoteMessageChannel = (typeof QUOTE_MESSAGE_CHANNELS)[number];

/** = app.quote_message_fields(): what a quote send fills beyond the card's fields (app.card_message_fields()). */
export const QUOTE_MESSAGE_FIELDS = ["מסמך", "קישור להצעה", "תוקף"] as const;

const VALIDITY = "{תוקף}";

type TemplateText = { messageType: string | null; subject?: string | null; body: string };

export type QuoteTemplate = TemplateText & {
  id: string;
  name: string;
  channel: string;
  isActive: boolean;
  noticeKind?: string | null;
};

/** The merge fields a quote send leaves without a value (= app.quote_unfillable_fields). */
export function quoteUnfillableFields(template: TemplateText): string[] {
  return cardUnfillableFields(template).filter((name) => !(QUOTE_MESSAGE_FIELDS as readonly string[]).includes(name));
}

/**
 * The templates the dialog offers for a channel: active requested_document templates of that channel that a person may send
 * (not one the system sends itself), whose every field a quote send fills; {תוקף} only when the quote has a validity date.
 */
export function quoteMessageTemplates<T extends QuoteTemplate>(templates: readonly T[], channel: QuoteMessageChannel, hasValidity: boolean): T[] {
  return templates.filter(
    (t) =>
      t.channel === channel &&
      t.isActive &&
      !t.noticeKind &&
      t.messageType === "requested_document" &&
      quoteUnfillableFields(t).length === 0 &&
      // an optional part ("{ בתוקף עד {תוקף}}") disappears without a value, so only a bare {תוקף} needs a validity date
      (hasValidity || !`${t.subject ?? ""}\n${t.body}`.replace(OPTIONAL_PART_PATTERN, "").includes(VALIDITY)),
  );
}

/** "הצעת מחיר <number>", as the composer fills {מסמך}. */
export function quoteDocumentName(numberDisplay: string | null): string {
  return `הצעת מחיר ${numberDisplay ?? ""}`.trim();
}

/** The preview: the template filled with the quote's values; the link is minted when it goes, so it shows as a placeholder. */
export function quoteMessagePreview(template: TemplateText, values: MergeValues): { subject: string | null; body: string; unfilled: string[] } {
  const withLink: MergeValues = { ...values, quoteLink: "[הקישור להצעה]" };
  const subject = template.subject ? fillMessage(template.subject, withLink) : null;
  const body = fillMessage(template.body, withLink);
  return { subject, body, unfilled: unfilledMergeFields(`${subject ?? ""}\n${body}`) };
}

export type QueuedQuoteMessage = {
  jobId: string;
  createdAt: string;
  channel: QuoteMessageChannel;
  templateName: string | null;
  senderId: string | null;
  state: "waiting" | "sent" | "not_sent";
  reason: "consent" | "paused" | "unfilled" | "quote_changed" | "pages_closed" | "reminder_off" | "other" | null;
};

const STATES = new Set(["waiting", "sent", "not_sent"]);
const REASONS = new Set(["consent", "paused", "unfilled", "quote_changed", "pages_closed", "reminder_off", "other"]);

/** Parses public.quote_message_queue's answer; a malformed row is left out. */
export function queuedQuoteMessages(data: unknown): QueuedQuoteMessage[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((row): QueuedQuoteMessage[] => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    if (typeof r.job_id !== "string" || typeof r.created_at !== "string" || typeof r.state !== "string" || !STATES.has(r.state)) return [];
    if (r.channel !== "email" && r.channel !== "sms") return [];
    return [
      {
        jobId: r.job_id,
        createdAt: r.created_at,
        channel: r.channel,
        templateName: typeof r.template_name === "string" ? r.template_name : null,
        senderId: typeof r.sender_id === "string" ? r.sender_id : null,
        state: r.state as QueuedQuoteMessage["state"],
        reason: typeof r.reason === "string" && REASONS.has(r.reason) ? (r.reason as QueuedQuoteMessage["reason"]) : null,
      },
    ];
  });
}

/** One line per message: waiting, sent, or not sent and why in plain words. */
export function queuedQuoteMessageText(message: Pick<QueuedQuoteMessage, "state" | "reason">): string {
  if (message.state === "waiting") return "ממתינה לשליחה";
  if (message.state === "sent") return "נשלחה";
  if (message.reason === "consent") return "לא נשלחה: הכתובת או המספר חסומים";
  if (message.reason === "paused") return "לא נשלחה: השליחה ללקוחות הייתה עצורה יותר מיממה";
  if (message.reason === "unfilled") return "לא נשלחה: בתבנית יש שדה בלי ערך";
  if (message.reason === "quote_changed") return "לא נשלחה: ההצעה או הלקוח שלה השתנו לפני השליחה";
  if (message.reason === "pages_closed") return "לא נשלחה: הדפים ללקוחות של העסק סגורים";
  if (message.reason === "reminder_off") return "לא נשלחה: התזכורות כובו או אינן כלולות בחבילה";
  return "לא נשלחה";
}

export const CHANNEL_LABELS: Record<QuoteMessageChannel, string> = { email: "אימייל", sms: "SMS" };

/** DRAFT wording: what the dialog says first, while the quote already has a live link. */
export const LINK_REPLACED_NOTE = "ההודעה תצא עם קישור חדש להצעה. הקישור הקודם שנשלח ללקוח יפסיק לעבוד.";

/** What the dialog says after the message was queued. */
export function queuedQuoteMessage(channel: QuoteMessageChannel, paused: boolean): string {
  const what = channel === "email" ? "האימייל" : "ה-SMS";
  return paused
    ? `${what} נכנס לתור השליחה. השליחה ללקוחות עצורה כרגע, והוא יישלח כשהיא תחודש.`
    : `${what} נכנס לתור השליחה. מצב השליחה מופיע כאן וברשומת הלקוח.`;
}
