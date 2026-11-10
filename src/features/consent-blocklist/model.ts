// CNS-06: the closed lists of public.consent_blocklist (constraints consent_blocklist_channel, consent_blocklist_reason,
// consent_blocklist_removed_reason). tests/unit/consent-blocklist.test.ts keeps them equal to the migration. The labels
// of the reasons are a DRAFT until the lawyer edits them.

export const BLOCKLIST_CHANNELS = ["all", "email", "sms", "whatsapp", "phone"] as const;
export type BlocklistChannel = (typeof BLOCKLIST_CHANNELS)[number];

export const BLOCKLIST_CHANNEL_LABELS: Record<BlocklistChannel, string> = {
  all: "כל הערוצים",
  email: "אימייל",
  sms: "SMS",
  whatsapp: "WhatsApp",
  phone: "שיחות טלפון",
};

/** The reasons a person picks when adding addresses (public.consent_blocklist_add_noted accepts only these). */
export const BLOCKLIST_PERSON_REASONS = ["person_request", "complaint", "legal", "not_the_person", "other"] as const;
export type BlocklistPersonReason = (typeof BLOCKLIST_PERSON_REASONS)[number];

/**
 * Every stored reason (constraint consent_blocklist_reason): the person's ones and 'sms_reply', written only by the server
 * when a customer answers an SMS with an opt-out word (SMS-03, owner's answer (208) ב).
 */
// CNS-09 adds 'unsubscribe_link': a customer unsubscribed through the link of a message or the preferences page
export const BLOCKLIST_REASONS = [...BLOCKLIST_PERSON_REASONS, "sms_reply", "unsubscribe_link"] as const;
export type BlocklistReason = (typeof BLOCKLIST_REASONS)[number];

export const BLOCKLIST_REASON_LABELS: Record<BlocklistReason, string> = {
  person_request: "האדם ביקש לא לקבל דיוור",
  complaint: "תלונה",
  legal: "דרישה משפטית",
  not_the_person: "הכתובת לא שייכת לאדם שחשבנו",
  other: "אחר",
  sms_reply: "בקשת הסרה ב-SMS",
  unsubscribe_link: "בקשת הסרה בקישור",
};

/** The reasons a person picks when removing an entry (public.consent_blocklist_remove accepts only these). */
export const BLOCKLIST_PERSON_REMOVED_REASONS = ["added_by_mistake", "person_consented", "other"] as const;
/**
 * Every stored removal reason (constraint consent_blocklist_removed_reason): the person's ones and 'resubscribed', written only by
 * the server when a customer turns a channel back on from the preferences page after their own unsubscribe (CNS-10, owner (231) ב).
 */
// ... and 'superseded': a link's own entry replaced by a stronger one on the same channel (delta review 1)
export const BLOCKLIST_REMOVED_REASONS = [...BLOCKLIST_PERSON_REMOVED_REASONS, "resubscribed", "superseded"] as const;
export type BlocklistRemovedReason = (typeof BLOCKLIST_REMOVED_REASONS)[number];

export const BLOCKLIST_REMOVED_REASON_LABELS: Record<BlocklistRemovedReason, string> = {
  added_by_mistake: "נוספה בטעות",
  person_consented: "האדם ביקש בעצמו לחזור לקבל דיוור",
  other: "אחר",
  resubscribed: "הלקוח חידש את ההרשמה בדף ההעדפות",
  superseded: "הוחלפה ברשומת חסימה אחרת לאותה כתובת",
};

/**
 * CNS-06 answer 4 (owner, 26 October 2026): an optional note on the entries of one add, emptied when the person is erased
 * (constraint consent_blocklist_note; the database refuses more: consent_blocklist:note).
 */
export const BLOCKLIST_NOTE_MAX = 200;

/** At most this many addresses in one add (the database refuses more: consent_blocklist:too_many). */
export const BLOCKLIST_ADD_MAX = 500;

/**
 * Splits pasted text into addresses: one per line, or separated by commas or semicolons. Spaces inside a phone stay
 * (the database normalizes it); empty pieces are dropped.
 */
export function splitAddresses(text: string): string[] {
  return text
    .split(/[\n\r,;]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function isBlocklistChannel(value: unknown): value is BlocklistChannel {
  return typeof value === "string" && (BLOCKLIST_CHANNELS as readonly string[]).includes(value);
}
export function isBlocklistReason(value: unknown): value is BlocklistReason {
  return typeof value === "string" && (BLOCKLIST_REASONS as readonly string[]).includes(value);
}
export function isBlocklistRemovedReason(value: unknown): value is BlocklistRemovedReason {
  return typeof value === "string" && (BLOCKLIST_REMOVED_REASONS as readonly string[]).includes(value);
}
