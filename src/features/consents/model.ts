import type { BadgeTone } from "@/components/ui/badge";

// CNS-01: the closed lists of public.consents (check constraints consents_channel,
// consents_state, consents_source). tests/unit/consents.test.ts keeps them equal to the migration.

export const CONSENT_CHANNELS = ["email", "sms", "whatsapp", "phone"] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];

// "awaiting_confirmation" (CAP-07 follow-up): a public-form tick for an address that opted out, asked to be erased or is
// on the blocklist; it lifts nothing and waits for a double opt-in (the server writes it, never a person)
export const CONSENT_STATES = ["granted", "denied", "withdrawn", "unknown", "awaiting_confirmation"] as const;
export type ConsentState = (typeof CONSENT_STATES)[number];

export const CONSENT_SOURCES = ["form", "manual", "import", "api", "unsubscribe", "erasure"] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

/** What a person may record by hand (CNS-03); "unknown" is what no entry means. */
export const MANUAL_STATES = ["granted", "denied", "withdrawn"] as const satisfies readonly ConsentState[];

export const CHANNEL_LABELS: Record<ConsentChannel, string> = {
  email: "אימייל",
  sms: "SMS",
  whatsapp: "WhatsApp",
  phone: "שיחות טלפון",
};

export const STATE_LABELS: Record<ConsentState, string> = {
  granted: "הסכים",
  denied: "לא הסכים",
  withdrawn: "הסיר את עצמו",
  unknown: "לא ידוע",
  awaiting_confirmation: "ממתין לאישור כפול",
};

export const STATE_TONES: Record<ConsentState, BadgeTone> = {
  granted: "success",
  denied: "neutral",
  withdrawn: "danger",
  unknown: "neutral",
  awaiting_confirmation: "warning",
};

// CNS-06: the card's word when the record's own address is blocked for marketing (public.consent_record_blocks)
export const BLOCK_LABELS = {
  listed: "ברשימת החסימה של העסק",
  blocked: "חסום לדיוור",
} as const;

export const SOURCE_LABELS: Record<ConsentSource, string> = {
  form: "טופס",
  manual: "רישום ידני",
  import: "ייבוא",
  api: "API",
  unsubscribe: "הודעת הסרה",
  // a privacy erasure paused until the server can complete it: no contact meanwhile
  erasure: "בקשת מחיקה",
};

// the record's address a channel needs: a phone for SMS, WhatsApp and calls, an email for email
export function channelNeeds(channel: ConsentChannel): "phone" | "email" {
  return channel === "email" ? "email" : "phone";
}

export function isConsentChannel(value: unknown): value is ConsentChannel {
  return typeof value === "string" && (CONSENT_CHANNELS as readonly string[]).includes(value);
}
export function isConsentState(value: unknown): value is ConsentState {
  return typeof value === "string" && (CONSENT_STATES as readonly string[]).includes(value);
}
export function isConsentSource(value: unknown): value is ConsentSource {
  return typeof value === "string" && (CONSENT_SOURCES as readonly string[]).includes(value);
}

// How the person asked again, for an owner's or admin's manual lift of an opt-out (owner,
// 13 October 2026). DRAFT wording until the lawyer approves; mirrors consents_lift_method.
export const LIFT_METHODS = ["signed_form", "written_message", "recorded_call"] as const;
export type LiftMethod = (typeof LIFT_METHODS)[number];
export const LIFT_METHOD_LABELS: Record<LiftMethod, string> = {
  signed_form: "טופס חתום",
  written_message: "הודעה כתובה מהאדם",
  recorded_call: "שיחה מוקלטת",
};
export const LIFT_NOTE_MAX = 500;

export const METHOD_MAX = 500;
export const WORDING_MAX = 2000;
