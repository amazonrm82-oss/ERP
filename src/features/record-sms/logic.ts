// SMS-02: one SMS to the customer from the record's card, from an SMS template. It is queued as an OPS-04 message.send job by
// public.record_sms_send (migration sms_b_send), which judges everything again; these are the dialog's own rules and texts,
// kept equal to the database's (tests/unit/record-sms.test.ts reads the migration). EML-02's shape, without attachments.

import { marketingEnvelope } from "@/features/message-templates/envelope";
import { fillMessage, unfilledMergeFields, type MergeValues } from "@/features/message-templates/fields";
import { envelopedFilledProblem } from "@/features/message-templates/service-rule";
import type { MessageType } from "@/features/messaging/providers/types";
import { CARD_SERVICE_TYPES, type CardTemplate } from "@/features/record-email/logic";

export const RECORD_SMS_KINDS = ["lead", "contact", "deal"] as const;
export type RecordSmsKind = (typeof RECORD_SMS_KINDS)[number];

/** = app.record_sms_hourly_limit(): SMS a person sends from cards in an hour, across every business. */
export const RECORD_SMS_HOURLY_LIMIT = 30;

/**
 * = app.record_sms_service_types(): EML-02's list, the service types a card or an automation may send as an SMS; collection
 * only for whoever records payments (a card) and with the plan keys. Every other type is marketing (the queue's consent check).
 */
export const SMS_SERVICE_TYPES = CARD_SERVICE_TYPES;

/** The templates the dialog offers: active SMS templates of marketing or a card's service type (collection only for a payment recorder). */
export function cardSmsTemplates<T extends CardTemplate>(templates: readonly T[], canRecordPayments: boolean): T[] {
  return templates.filter(
    (t) =>
      t.channel === "sms" &&
      t.isActive &&
      (t.messageType === "marketing" ||
        ((SMS_SERVICE_TYPES as readonly string[]).includes(t.messageType) && (t.messageType !== "collection" || canRecordPayments))),
  );
}

/** The basic GSM 03.38 alphabet: a message of these characters only goes 160 a part (153 when split), else 70 (67). */
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_SET = new Set([...GSM_BASIC]);

/** How many SMS parts a text takes (Hebrew is always 70 a part, 67 when split). 0 for an empty text. */
export function smsParts(text: string): { characters: number; parts: number } {
  const gsm = [...text].every((ch) => GSM_SET.has(ch));
  const characters = gsm ? [...text].length : text.length;
  if (characters === 0) return { characters, parts: 0 };
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  return { characters, parts: characters <= single ? 1 : Math.ceil(characters / multi) };
}

export type SmsPreview = { body: string; unfilled: string[]; marketing: boolean; tooLong: boolean; characters: number; parts: number };

/**
 * The SMS as the customer will get it: a marketing template inside the envelope the system adds ("פרסומת: " in front, the sender
 * line and the unsubscribe line; MSG-02, owner (88) and (92)), then the record's values; and whether it passes the channel's cap
 * after filling (app.message_filled_problem: service 300, marketing 600). A field the dialog has no value for stays as it is.
 */
export function smsPreview(template: Pick<CardTemplate, "messageType" | "body">, values: MergeValues): SmsPreview {
  const input = { channel: "sms" as const, messageType: template.messageType, subject: null, body: template.body };
  const body = fillMessage(marketingEnvelope(input).body, values);
  const tooLong = envelopedFilledProblem(input, (text) => fillMessage(text, values)) === "too_long";
  return { body, unfilled: unfilledMergeFields(body), marketing: template.messageType === "marketing", tooLong, ...smsParts(body) };
}

export type QueuedSms = {
  jobId: string;
  createdAt: string;
  templateName: string | null;
  senderId: string | null;
  state: "waiting" | "sent" | "not_sent";
  reason: "consent" | "paused" | "other" | null;
};

const STATES = new Set(["waiting", "sent", "not_sent"]);
const REASONS = new Set(["consent", "paused", "other"]);

/** Parses public.record_sms_queue's answer; a malformed row is left out. */
export function queuedSms(data: unknown): QueuedSms[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((row): QueuedSms[] => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    if (typeof r.job_id !== "string" || typeof r.created_at !== "string" || typeof r.state !== "string" || !STATES.has(r.state)) return [];
    return [
      {
        jobId: r.job_id,
        createdAt: r.created_at,
        templateName: typeof r.template_name === "string" ? r.template_name : null,
        senderId: typeof r.sender_id === "string" ? r.sender_id : null,
        state: r.state as QueuedSms["state"],
        reason: typeof r.reason === "string" && REASONS.has(r.reason) ? (r.reason as QueuedSms["reason"]) : null,
      },
    ];
  });
}

/** One line per queued SMS: waiting (no provider yet, or paused), sent, or not sent and why in plain words. */
export function queuedSmsStateText(sms: Pick<QueuedSms, "state" | "reason">): string {
  if (sms.state === "waiting") return "ממתין לשליחה";
  if (sms.state === "sent") return "נשלח";
  if (sms.reason === "consent") return "לא נשלח: אין הסכמה לקבל הודעות שיווקיות ב-SMS, או שהמספר חסום";
  if (sms.reason === "paused") return "לא נשלח: השליחה ללקוחות הייתה עצורה יותר מיממה";
  return "לא נשלח";
}

/** What the dialog says after the SMS was queued. */
export function queuedSmsMessage(paused: boolean): string {
  return paused ? "ה-SMS ממתין לשליחה. השליחה ללקוחות עצורה כרגע, והוא יישלח כשהיא תחודש." : "ה-SMS ממתין לשליחה.";
}

/** Whether a type is one a card may send at all (marketing, or the card's service list). */
export function smsCardType(type: MessageType): boolean {
  return type === "marketing" || (SMS_SERVICE_TYPES as readonly string[]).includes(type);
}

export const SMS_TOO_LONG = "ההודעה ארוכה מדי אחרי מילוי השדות: עד 300 תווים להודעת שירות, ועד 600 להודעת שיווק (כולל מה שהמערכת מוסיפה). קצרו את התבנית.";
