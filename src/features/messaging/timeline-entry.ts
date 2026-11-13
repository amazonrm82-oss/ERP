// MSG-03: a kept message drawn as a read-only timeline entry. Pure, so the wording is unit-tested.

export const MESSAGE_TIMELINE_TYPE = "message_log";

const OUTBOUND: Record<string, string> = { email: "אימייל יוצא", sms: "SMS יוצא", whatsapp: "הודעת WhatsApp יוצאת" };
const INBOUND: Record<string, string> = { email: "אימייל נכנס", sms: "SMS נכנס", whatsapp: "הודעת WhatsApp נכנסת" };

const STATUS: Record<string, string> = {
  sent: "נשלחה.",
  delivered: "נמסרה.",
  read: "נקראה.",
  failed: "השליחה נכשלה.",
  received: "התקבלה.",
};

export type MessageEntryInput = {
  channel: string;
  direction: string;
  status: string;
  provider?: string | null;
  provider_error_code?: string | null;
};

// Owner (96): a message whose filled text passed the channel's cap is not sent and is logged with this code and NO
// provider (the system's own refusal; a provider's error code that happens to read the same is a provider failure).
// RVW-89: every final refusal of the SMS composer (app.sms_compose_core, 021247, and the codes it passes on from
// app.message_template_sendable, app.message_filled_problem, app.collection_customer_refusal and the link minters) has its
// own line; 'stale', 'paused' and 'site_url' are never final (the job is tried again), so they never reach a message row.
// A code not listed here keeps the plain "השליחה נכשלה.".
export const REFUSED: Record<string, string> = {
  too_long: "לא נשלחה: ארוכה מדי.",
  unfilled_field: "לא נשלחה: שדה בהודעה לא התמלא (בהודעת שיווק: כתובת או טלפון העסק בהגדרות המסמכים).",
  feature_off: "לא נשלחה: האפשרות כבויה או לא כלולה בחבילה.",
  link_blocked: "לא נשלחה: הקישורים החיצוניים של העסק כבויים.",
  link_invalid: "לא נשלחה: הקישור לביקורת לא תקין.",
  consent_missing: "לא נשלחה: אין הסכמה מתועדת לדיוור.",
  consent_suppressed: "לא נשלחה: הלקוח ביקש לא לקבל דיוור.",
  consent_blocked: "לא נשלחה: המספר חסום לשליחה.",
  consent_unknown: "לא נשלחה: לא ניתן היה לבדוק הסכמה.",
  no_phone: "לא נשלחה: אין מספר טלפון.",
  address_changed: "לא נשלחה: מספר הטלפון השתנה.",
  no_customer: "לא נשלחה: אין לקוח להודעה.",
  record_gone: "לא נשלחה: הרשומה נמחקה.",
  customer_changed: "לא נשלחה: הלקוח השתנה.",
  not_found: "לא נשלחה: התבנית נמחקה.",
  inactive: "לא נשלחה: התבנית כבויה.",
  template_changed: "לא נשלחה: התבנית השתנתה.",
  field_not_allowed: "לא נשלחה: בתבנית שדה שלא מתאים לסוג ההודעה.",
  external_link: "לא נשלחה: בתבנית קישור חיצוני.",
  glued_address: "לא נשלחה: בתבנית כתובת צמודה לטקסט.",
  offer: "לא נשלחה: בתבנית מחיר, הנחה או מילה שיווקית.",
  meeting_changed: "לא נשלחה: הפגישה השתנתה.",
  document_changed: "לא נשלחה: המסמך השתנה.",
  request_changed: "לא נשלחה: הבקשה השתנתה.",
  card_changed: "לא נשלחה: הכרטיסייה השתנתה.",
  reminder_off: "לא נשלחה: התזכורת כובתה.",
  stage_off: "לא נשלחה: שלב התזכורת כובה.",
  business_off: "לא נשלחה: התזכורות לעסק כבויות.",
  debt_settled: "לא נשלחה: החוב שולם.",
  messages_off: "לא נשלחה: ההודעות ללקוח כבויות.",
  not_writable: "לא נשלחה: העסק לא פעיל.",
  business: "לא נשלחה: העסק לא פעיל.",
  not_sms: "לא נשלחה: ההודעה לא מתאימה לערוץ.",
  unsupported: "לא נשלחה: סוג ההודעה לא נתמך בערוץ הזה.",
  service_type: "לא נשלחה: סוג ההודעה לא נתמך בערוץ הזה.",
  no_link_field: "לא נשלחה: התבנית השתנתה.",
  not_a_meeting_message: "לא נשלחה: התבנית השתנתה.",
  link: "לא נשלחה: לא ניתן היה ליצור קישור.",
  changed: "לא נשלחה: ההודעה השתנתה בזמן ההכנה.",
};

/** The entry's label: channel and direction ("SMS יוצא"); an unknown channel reads "הודעה". */
export function messageEntryLabel(message: MessageEntryInput): string {
  const labels = message.direction === "inbound" ? INBOUND : OUTBOUND;
  return labels[message.channel] ?? (message.direction === "inbound" ? "הודעה נכנסת" : "הודעה יוצאת");
}

/** The entry's line: the delivery status only (the text itself is not kept in the system). */
export function messageEntryText(message: MessageEntryInput): string {
  if (message.status === "failed" && !message.provider && message.provider_error_code && Object.prototype.hasOwnProperty.call(REFUSED, message.provider_error_code)) {
    return REFUSED[message.provider_error_code];
  }
  return STATUS[message.status] ?? "";
}

/**
 * Pinned entries first (messages are never pinned), then newest first; entries at the same moment keep their order.
 * The page shows one time window: when either list came back full (its own limit reached), anything older than that
 * list's oldest item is left out of the other one too, so nothing older shows above a gap and nothing repeats or
 * jumps if a later page is added with the same window.
 */
export function mergeTimeline<T extends { pinned: boolean; occurredAt: string }>(
  entries: T[],
  messages: T[],
  full: { entries: boolean; messages: boolean } = { entries: false, messages: false },
): T[] {
  if (messages.length === 0) return entries;
  const time = (x: T) => Date.parse(x.occurredAt);
  const pinned = entries.filter((e) => e.pinned);
  const unpinned = entries.filter((e) => !e.pinned);
  const floors = [
    full.entries && unpinned.length > 0 ? Math.min(...unpinned.map(time)) : -Infinity,
    full.messages ? Math.min(...messages.map(time)) : -Infinity,
  ];
  const floor = Math.max(...floors);
  const rest = [...unpinned, ...messages].filter((x) => time(x) >= floor).sort((a, b) => time(b) - time(a));
  return [...pinned, ...rest];
}
