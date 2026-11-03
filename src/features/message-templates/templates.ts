import { CONTACT_LOCALE_LABELS, CONTACT_LOCALES, type ContactLocale } from "@/features/contacts/preferences";
import { MESSAGE_CHANNELS, MESSAGE_TYPES, SERVICE_MESSAGE_TYPES, type MessageChannel, type MessageType } from "@/features/messaging/providers/types";

// MSG-02 (owner 3 November 2026, answers (68) א and (73) א): shared message templates, every plan, no plan key, 50 per
// business. A template's type comes from the closed list of message types (MESSAGE_TYPES = app.message_types()); the
// service types are a closed list too (SERVICE_MESSAGE_TYPES), never a switch the business sets. Nothing sends from a
// template yet: AUT-08 and the sending modules will.

export const MESSAGE_TEMPLATES_PER_ORG = 50;
export const MESSAGE_TEMPLATE_NAME_MAX = 80;
export const MESSAGE_TEMPLATE_SUBJECT_MAX = 150;
export const MESSAGE_TEMPLATE_BODY_MAX = 2000;

export const TEMPLATE_CHANNELS = MESSAGE_CHANNELS;
export const TEMPLATE_CHANNEL_LABELS: Record<MessageChannel, string> = {
  email: "אימייל",
  sms: "SMS",
  whatsapp: "WhatsApp",
};

export const MESSAGE_TYPE_LABELS: Record<MessageType, string> = {
  meeting_reminder: "תזכורת לפגישה",
  requested_document: "מסמך שהלקוח ביקש",
  collection: "גבייה",
  verification_code: "קוד אימות",
  marketing: "שיווק",
};

export const TEMPLATE_LOCALES = CONTACT_LOCALES;
export const TEMPLATE_LOCALE_LABELS = CONTACT_LOCALE_LABELS;
export type TemplateLocale = ContactLocale;

export function isServiceType(type: MessageType): boolean {
  return (SERVICE_MESSAGE_TYPES as readonly string[]).includes(type);
}

/** "שירות" or "שיווק", for the list. */
export function purposeLabel(type: MessageType): string {
  return isServiceType(type) ? "הודעת שירות" : "הודעה שיווקית";
}

/** The type picker's options: the service types first, then marketing. */
export const MESSAGE_TYPE_OPTIONS: ReadonlyArray<{
  value: MessageType;
  label: string;
}> = MESSAGE_TYPES.map((type) => ({
  value: type,
  label: `${MESSAGE_TYPE_LABELS[type]} (${isServiceType(type) ? "שירות" : "שיווק"})`,
}));

// GSM-7 basic characters (with the space and line break); anything else makes an SMS a Unicode one (70 per message)
const GSM_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);

/** How long one SMS may be for this text: 160 in plain Latin characters, 70 once any other character (Hebrew) is in it. */
export function smsLimit(text: string): 70 | 160 {
  for (const char of text) {
    if (!GSM_BASIC.has(char)) return 70;
  }
  return 160;
}

/** A warning for an SMS longer than one message; null when it fits (no hard limit, owner's brief). */
export function smsLengthWarning(text: string): string | null {
  const length = [...text].length;
  const limit = smsLimit(text);
  if (length <= limit) return null;
  const perPart = limit === 70 ? 67 : 153;
  const parts = Math.ceil(length / perPart);
  return `ההודעה ארוכה מ-${limit} תווים (${length.toLocaleString("he-IL")}), ולכן תישלח כ-${parts} הודעות SMS מחוברות. אחרי מילוי השדות היא עשויה להיות ארוכה יותר.`;
}

// Every business starts with these and renames, changes or deletes them freely. The database seeds them
// (app.seed_message_templates); tests/unit/message-templates.test.ts keeps the two equal.
// Owner 3 November 2026, answer (88). DRAFT wording until the lawyer approves it (the settings page says "טיוטה").
// The quote email has no "אם יש שאלות, אפשר לענות למייל הזה." line: it may be added once an email reply-to equal to the
// business's email exists (no email provider or reply-to setting yet). The marketing update holds only its greeting and
// content; "פרסומת", the sender line and the unsubscribe line come from marketingEnvelope() (envelope.ts).
export const DEFAULT_MESSAGE_TEMPLATES: ReadonlyArray<{
  name: string;
  channel: MessageChannel;
  messageType: MessageType;
  subject: string | null;
  body: string;
}> = [
  {
    name: "תזכורת לפגישה",
    channel: "sms",
    messageType: "meeting_reminder",
    subject: null,
    body: "שלום {שם פרטי}, תזכורת לפגישה ב-{תאריך} בשעה {שעה}. לשינוי או ביטול: {טלפון העסק}. {שם העסק}",
  },
  {
    name: "הצעת מחיר",
    channel: "email",
    messageType: "requested_document",
    subject: "הצעת המחיר מ{שם העסק}",
    body: "שלום {שם פרטי},\n\nהצעת המחיר מחכה כאן: {קישור להצעה}\nההצעה בתוקף עד {תוקף}.\n\n{שם הנציג}, {שם העסק}",
  },
  {
    name: "תזכורת לתשלום",
    channel: "sms",
    messageType: "collection",
    subject: null,
    body: "שלום {שם פרטי}, תזכורת: {מסמך} על סך {סכום}, מועד התשלום {מועד תשלום}. אם כבר שילמתם, תודה. {שם העסק}",
  },
  {
    name: "עדכון ללקוחות",
    channel: "email",
    messageType: "marketing",
    subject: "פרסומת: חדש ב{שם העסק}",
    body: "שלום {שם פרטי}, {תוכן העדכון}",
  },
];
