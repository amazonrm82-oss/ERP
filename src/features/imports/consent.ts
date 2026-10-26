// CNS-05: marketing consent columns in a leads or contacts import. Shared by the wizard (browser) and the import
// action (server). The declaration's list mirrors import_jobs_consent_method_known and app.import_consent_method_label
// (migration *_import_consent.sql; tests/unit/import-consent.test.ts keeps them equal). Its wording is a DRAFT until the
// lawyer edits it.

import { z } from "zod";

import { CHANNEL_LABELS } from "@/features/consents/model";
import { formatNumber } from "@/lib/format";

export const IMPORT_CONSENT_CHANNELS = ["email", "sms", "whatsapp"] as const;
export type ImportConsentChannel = (typeof IMPORT_CONSENT_CHANNELS)[number];

/** The mapping target of each channel's column. */
export const CONSENT_TARGET: Record<ImportConsentChannel, string> = {
  email: "consent_email",
  sms: "consent_sms",
  whatsapp: "consent_whatsapp",
};

export function consentChannelOf(target: string): ImportConsentChannel | null {
  return IMPORT_CONSENT_CHANNELS.find((c) => CONSENT_TARGET[c] === target) ?? null;
}

/** Whether a mapping has any consent column. */
export function mapsConsent(mapping: readonly string[]): boolean {
  return mapping.some((target) => consentChannelOf(target) !== null);
}

/** The wizard's targets for a leads or contacts file (no generic synonyms: a column is never guessed as consent). */
export const CONSENT_TARGETS = [
  {
    key: CONSENT_TARGET.email,
    label: "הסכמה לדיוור באימייל (כן / לא)",
    synonyms: ["הסכמה לאימייל", "הסכמה לדיוור באימייל", "אישור דיוור באימייל", "email consent", "email opt in"],
  },
  { key: CONSENT_TARGET.sms, label: "הסכמה לדיוור ב-SMS (כן / לא)", synonyms: ["הסכמה ל-SMS", "הסכמה לSMS", "הסכמה לדיוור ב-SMS", "sms consent", "sms opt in"] },
  {
    key: CONSENT_TARGET.whatsapp,
    label: "הסכמה לדיוור ב-WhatsApp (כן / לא)",
    synonyms: ["הסכמה לוואטסאפ", "הסכמה ל-WhatsApp", "הסכמה לדיוור בוואטסאפ", "whatsapp consent", "whatsapp opt in"],
  },
];

// The closed list of cell values (lower case, spaces folded). Empty = nothing written; anything else = not guessed.
// Owner, 26 October 2026 (answer 3 (ג)): also "אישר", "אושר" (and v, ✔, מאשרת, מסכימה, x, which were already here).
export const CONSENT_GRANTED_VALUES = [
  "כן",
  "מאשר",
  "מאשרת",
  "אישר",
  "אושר",
  "מסכים",
  "מסכימה",
  "yes",
  "y",
  "true",
  "1",
  "v",
  "✓",
  "✔",
] as const;
export const CONSENT_DENIED_VALUES = ["לא", "לא מאשר", "לא מאשרת", "לא מסכים", "לא מסכימה", "no", "n", "false", "0", "x", "✗", "✘"] as const;

export type ConsentCell = "granted" | "denied" | null | "invalid";

/** A consent cell: "granted", "denied", null (empty: nothing is written) or "invalid" (the row's consent is skipped). */
export function parseConsentCell(value: string | null | undefined): ConsentCell {
  const v = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (v === "") return null;
  if ((CONSENT_GRANTED_VALUES as readonly string[]).includes(v)) return "granted";
  if ((CONSENT_DENIED_VALUES as readonly string[]).includes(v)) return "denied";
  return "invalid";
}

export const IMPORT_CONSENT_METHODS = ["website_form", "signed_form", "event", "purchase", "previous_system", "other"] as const;
export type ImportConsentMethod = (typeof IMPORT_CONSENT_METHODS)[number];
// DRAFT wording until the lawyer edits it; equal to app.import_consent_method_label
export const IMPORT_CONSENT_METHOD_LABELS: Record<ImportConsentMethod, string> = {
  website_form: "טופס הרשמה באתר או בדף נחיתה",
  signed_form: "טופס או הסכם חתום",
  event: "הרשמה באירוע, בכנס או בחנות",
  purchase: "אישור דיוור בזמן קנייה",
  previous_system: "מערכת קודמת שבה נרשמו ההסכמות",
  other: "אחר",
};
export const IMPORT_CONSENT_NOTE_MAX = 500;

export const consentDeclarationSchema = z.object({
  method: z.enum(IMPORT_CONSENT_METHODS, { error: "בחרו איך התקבלו ההסכמות." }),
  note: z
    .string()
    .trim()
    .min(1, "כתבו בקצרה מאיפה הרשימה ומתי נאספו ההסכמות.")
    .max(IMPORT_CONSENT_NOTE_MAX, `עד ${IMPORT_CONSENT_NOTE_MAX} תווים.`),
});
export type ConsentDeclaration = z.infer<typeof consentDeclarationSchema>;

/** What the database answered for one consent (public.import_record_consents). */
export type ConsentResult = "written" | "locked" | "other_address" | "refused" | "invalid";

// "לאימייל", "ל-SMS", "ל-WhatsApp"
const toChannel = (channel: ImportConsentChannel) => (channel === "email" ? "לאימייל" : `ל-${CHANNEL_LABELS[channel]}`);

export const consentValueUnknown = (channel: ImportConsentChannel, value: string) =>
  `הערך "${value}" בעמודת ההסכמה ${toChannel(channel)} לא מוכר (כן או לא). ההסכמה לא נרשמה.`;
export const consentNoAddress = (channel: ImportConsentChannel) =>
  `אין בשורה ${channel === "email" ? "אימייל" : "טלפון"}, ולכן ההסכמה ${toChannel(channel)} לא נרשמה.`;

/**
 * CNS-05 undo (owner, 26 October 2026): the sentence added to "הייבוא בוטל." when undoing it cancelled consents the import
 * recorded (public.undo_import / undo_own_import answer `consents` only when there were any); "" otherwise.
 */
export function consentsUndoneText(count: number | null | undefined): string {
  if (!count || count < 1) return "";
  return count === 1 ? " גם ההסכמה לדיוור שנרשמה בו בוטלה." : ` גם ${count} ההסכמות לדיוור שנרשמו בו בוטלו.`;
}

/**
 * CNS-06 answer 3 (owner, 26 October 2026): the import report's line for the consents kept out because the address opted
 * out, was erased or is on the blocklist (public.import_record_consents answered 'locked'); "" when there were none.
 */
export function consentsLockedText(count: number | null | undefined): string {
  if (!count || count < 1) return "";
  return count === 1
    ? "כתובת אחת חסומה או שהוסרה: לא נרשמה הסכמה."
    : `${formatNumber(count)} כתובות חסומות או שהוסרו: לא נרשמה הסכמה.`;
}

/** The row's warning for a consent the database did not write; null when it was written. */
export function consentResultWarning(channel: ImportConsentChannel, result: ConsentResult): string | null {
  if (result === "written") return null;
  // one text for an opt-out and an erasure block alike (review of 8274c04)
  if (result === "locked") return `ההסכמה ${toChannel(channel)} לא עודכנה: הכתובת חסומה לדיוור בעסק.`;
  if (result === "other_address") {
    return `ההסכמה ${toChannel(channel)} לא נרשמה: ${channel === "email" ? "האימייל" : "הטלפון"} בקובץ אינו הראשי ברשומה.`;
  }
  return `ההסכמה ${toChannel(channel)} לא נרשמה.`;
}
