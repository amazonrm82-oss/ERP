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
  punch_card_notice: "כרטיסייה",
  instant_reply: "מענה מיידי לפנייה",
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

// Owner 3 November 2026, answer (89) א: a quote email ("הצעת מחיר", type requested_document) is a SERVICE message only on
// these conditions, which every future quote sender must hold (nothing sends yet):
// * it is sent from the quote's own screen, or by an automation on the quote's deal;
// * only to the customer address on that quote (the quote's contact), one recipient;
// * never to a group or a segment (a campaign of quotes is marketing, and needs consent);
// * the blocklist and a privacy erasure stop it (app.consent_service_blocked through job_message_may_send), like every
//   service message; an ordinary opt-out does not.
// The service template rule (owner (90) ג, service-rule.ts) holds for it as for every service template.
export const QUOTE_SERVICE_CONDITIONS = {
  origins: ["quote_screen", "deal_automation"],
  recipient: "quote_customer",
  groupSend: false,
} as const;

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

// PKG-03 (owner 4 November 2026, answer (128) א): the two punch card notices the alert job sends from (server-only mark
// notice_kind), seeded by app.seed_punch_card_message_templates; tests/unit/message-templates.test.ts keeps the two equal.
// DRAFT wording until the lawyer edits it. The owner's one text "נשארו {כניסות} כניסות / התוקף עד {תאריך}" is split at the
// "/": a card with few entries and no expiry has no date to fill.
export const DEFAULT_PUNCH_CARD_TEMPLATES: ReadonlyArray<{
  name: string;
  channel: MessageChannel;
  messageType: MessageType;
  subject: null;
  body: string;
  noticeKind: "punch_card_low" | "punch_card_expiry";
}> = [
  {
    name: "כרטיסייה: נשארו מעט כניסות",
    channel: "sms",
    messageType: "punch_card_notice",
    subject: null,
    // owner (138) ב: {כניסות} is the whole phrase, "נשארה כניסה אחת" / "נשארו 3 כניסות" (punchEntriesText)
    body: "שלום {שם פרטי}, בכרטיסייה {שם הכרטיסייה} {כניסות}. לפרטים: {טלפון העסק}. {שם העסק}",
    noticeKind: "punch_card_low",
  },
  {
    name: "כרטיסייה: התוקף מתקרב",
    channel: "sms",
    messageType: "punch_card_notice",
    subject: null,
    body: "שלום {שם פרטי}, בכרטיסייה {שם הכרטיסייה} התוקף עד {תאריך}. לפרטים: {טלפון העסק}. {שם העסק}",
    noticeKind: "punch_card_expiry",
  },
];

// CAL-12 (owner 9 November 2026, answer (182)): the meeting messages to the customer, SMS and email of each (server-only
// mark notice_kind), seeded by app.seed_meeting_customer_templates with the wording version below;
// tests/unit/meeting-customer-messages.test.ts keeps the two equal. DRAFT wording until the lawyer edits it. "{, ב-{מיקום}}"
// is an optional part (fillOptionalParts): shown only when the meeting has a location.
export const MEETING_MESSAGE_WORDING_VERSION = "meeting-draft-1";

export type MeetingNoticeKind = "meeting_confirm" | "meeting_moved" | "meeting_day" | "meeting_hour";

const CONFIRM_BODY = "שלום {שם פרטי}, נקבעה לך פגישה עם {שם העסק} ב-{תאריך} בשעה {שעה}{, ב-{מיקום}}. לאישור, ביטול או שינוי: {קישור}. {שם העסק}, {טלפון העסק}";
const DAY_BODY = "תזכורת: מחר, {תאריך} בשעה {שעה}, פגישה עם {שם העסק}{ ב-{מיקום}}. לאישור, ביטול או שינוי: {קישור}. {שם העסק}, {טלפון העסק}";
const HOUR_BODY = "הפגישה שלך עם {שם העסק} מתחילה בשעה {שעה}{, ב-{מיקום}}. {שם העסק}, {טלפון העסק}";
const MOVED_BODY = "הפגישה שלך עם {שם העסק} עברה ל-{תאריך} בשעה {שעה}{, ב-{מיקום}}. לאישור, ביטול או שינוי: {קישור}. {שם העסק}, {טלפון העסק}";

export const DEFAULT_MEETING_CUSTOMER_TEMPLATES: ReadonlyArray<{
  name: string;
  channel: MessageChannel;
  messageType: MessageType;
  subject: string | null;
  body: string;
  noticeKind: MeetingNoticeKind;
}> = [
  { name: "פגישה: אישור (SMS)", channel: "sms", messageType: "meeting_reminder", subject: null, body: CONFIRM_BODY, noticeKind: "meeting_confirm" },
  { name: "פגישה: אישור (אימייל)", channel: "email", messageType: "meeting_reminder", subject: "נקבעה לך פגישה עם {שם העסק}", body: CONFIRM_BODY, noticeKind: "meeting_confirm" },
  { name: "פגישה: תזכורת יום לפני (SMS)", channel: "sms", messageType: "meeting_reminder", subject: null, body: DAY_BODY, noticeKind: "meeting_day" },
  {
    name: "פגישה: תזכורת יום לפני (אימייל)",
    channel: "email",
    messageType: "meeting_reminder",
    subject: "תזכורת: פגישה מחר עם {שם העסק}",
    body: DAY_BODY,
    noticeKind: "meeting_day",
  },
  { name: "פגישה: תזכורת שעה לפני (SMS)", channel: "sms", messageType: "meeting_reminder", subject: null, body: HOUR_BODY, noticeKind: "meeting_hour" },
  {
    name: "פגישה: תזכורת שעה לפני (אימייל)",
    channel: "email",
    messageType: "meeting_reminder",
    subject: "הפגישה שלך עם {שם העסק} מתחילה בשעה {שעה}",
    body: HOUR_BODY,
    noticeKind: "meeting_hour",
  },
  { name: "פגישה: מועד חדש (SMS)", channel: "sms", messageType: "meeting_reminder", subject: null, body: MOVED_BODY, noticeKind: "meeting_moved" },
  {
    name: "פגישה: מועד חדש (אימייל)",
    channel: "email",
    messageType: "meeting_reminder",
    subject: "הפגישה שלך עם {שם העסק} עברה למועד חדש",
    body: MOVED_BODY,
    noticeKind: "meeting_moved",
  },
];

// SGN-03 (owner 11 November 2026, answer (249) א): the customer's one reminder before a document's last day, SMS and email
// (server-only mark notice_kind 'signature_reminder'), seeded by app.seed_signature_reminder_templates with the wording
// version below; tests/unit/signature-status-reminders.test.ts keeps the two equal. DRAFT wording until the lawyer edits it.
export const SIGNATURE_REMINDER_WORDING_VERSION = "signature-draft-1";

const SIGNATURE_REMINDER_BODY = 'שלום {שם פרטי}, המסמך "{שם המסמך}" מ-{שם העסק} ממתין לחתימתך עד {תאריך}: {קישור}. {שם העסק}, {טלפון העסק}';

export const DEFAULT_SIGNATURE_REMINDER_TEMPLATES: ReadonlyArray<{
  name: string;
  channel: MessageChannel;
  messageType: MessageType;
  subject: string | null;
  body: string;
  noticeKind: "signature_reminder";
}> = [
  { name: "מסמך לחתימה: תזכורת (SMS)", channel: "sms", messageType: "requested_document", subject: null, body: SIGNATURE_REMINDER_BODY, noticeKind: "signature_reminder" },
  {
    name: "מסמך לחתימה: תזכורת (אימייל)",
    channel: "email",
    messageType: "requested_document",
    subject: "מסמך מ-{שם העסק} ממתין לחתימתך",
    body: SIGNATURE_REMINDER_BODY,
    noticeKind: "signature_reminder",
  },
];

// SPD-04 (owner (80) א, 3 November 2026): the instant reply to a web form inquiry, SMS and email, in working hours and
// outside them (server-only mark notice_kind), seeded by app.seed_instant_reply_templates with the wording version below
// when a form's switch is first turned on; tests/unit/instant-reply.test.ts keeps the two equal. DRAFT wording until the
// lawyer edits it. {שעה} is the return time in the business's zone; outside working hours "ביום העבודה הבא עד {שעה}" (owner
// (261) א). The two marked templates are fixed: a person only switches them off or on (hint message_template:fixed_notice).
export const INSTANT_REPLY_WORDING_VERSION = "instant-reply-draft-1";

export type InstantReplyNoticeKind = "instant_reply_open" | "instant_reply_closed";

const INSTANT_OPEN_BODY = "שלום {שם פרטי}, קיבלנו את הפנייה שלך ל-{שם העסק}. נחזור אליך עד השעה {שעה}. {שם העסק}, {טלפון העסק}";
const INSTANT_CLOSED_BODY = "שלום {שם פרטי}, קיבלנו את הפנייה שלך ל-{שם העסק}. נחזור אליך ביום העבודה הבא עד {שעה}. {שם העסק}, {טלפון העסק}";
const INSTANT_SUBJECT = "קיבלנו את הפנייה שלך ל-{שם העסק}";

export const DEFAULT_INSTANT_REPLY_TEMPLATES: ReadonlyArray<{
  name: string;
  channel: MessageChannel;
  messageType: MessageType;
  subject: string | null;
  body: string;
  noticeKind: InstantReplyNoticeKind;
}> = [
  { name: "מענה מיידי: בשעות הפעילות (SMS)", channel: "sms", messageType: "instant_reply", subject: null, body: INSTANT_OPEN_BODY, noticeKind: "instant_reply_open" },
  { name: "מענה מיידי: מחוץ לשעות הפעילות (SMS)", channel: "sms", messageType: "instant_reply", subject: null, body: INSTANT_CLOSED_BODY, noticeKind: "instant_reply_closed" },
  { name: "מענה מיידי: בשעות הפעילות (אימייל)", channel: "email", messageType: "instant_reply", subject: INSTANT_SUBJECT, body: INSTANT_OPEN_BODY, noticeKind: "instant_reply_open" },
  {
    name: "מענה מיידי: מחוץ לשעות הפעילות (אימייל)",
    channel: "email",
    messageType: "instant_reply",
    subject: INSTANT_SUBJECT,
    body: INSTANT_CLOSED_BODY,
    noticeKind: "instant_reply_closed",
  },
];

/** SPD-04 review 3: a template the system sends as an instant reply; its wording is fixed (= trigger message_templates_fixed_notice). */
export function isFixedNoticeTemplate(noticeKind: string | null | undefined): boolean {
  return noticeKind === "instant_reply_open" || noticeKind === "instant_reply_closed";
}

// COL-07 (owner's answers (255)-(258)): the collection reminder to the customer, SMS and email (server-only mark notice_kind
// 'collection_reminder'), seeded by app.seed_collection_reminder_templates with the wording version below the first time a
// business with the switch on reaches a stage; tests/unit/collection-customer-reminders.test.ts keeps the two equal. DRAFT
// wording until the lawyer edits it. Only the collection type's own fields (no link); {סכום} is the balance the sender reads
// when it sends.
export const COLLECTION_CUSTOMER_WORDING_VERSION = "collection-draft-1";

const COLLECTION_CUSTOMER_BODY =
  "שלום {שם פרטי}, תזכורת מ-{שם העסק}: {מסמך} על סך {סכום}, מועד התשלום {מועד תשלום}. אם כבר שילמתם, תודה. לפרטים: {טלפון העסק}";

export const DEFAULT_COLLECTION_CUSTOMER_TEMPLATES: ReadonlyArray<{
  name: string;
  channel: MessageChannel;
  messageType: MessageType;
  subject: string | null;
  body: string;
  noticeKind: "collection_reminder";
}> = [
  { name: "גבייה: תזכורת ללקוח (SMS)", channel: "sms", messageType: "collection", subject: null, body: COLLECTION_CUSTOMER_BODY, noticeKind: "collection_reminder" },
  {
    name: "גבייה: תזכורת ללקוח (אימייל)",
    channel: "email",
    messageType: "collection",
    subject: "תזכורת לתשלום מ-{שם העסק}",
    body: COLLECTION_CUSTOMER_BODY,
    noticeKind: "collection_reminder",
  },
];
