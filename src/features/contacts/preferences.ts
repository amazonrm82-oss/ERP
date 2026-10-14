// CON-10: a contact's preferred language and preferred channel. Both lists mirror the check
// constraints contacts_preferred_locale_check / contacts_preferred_channel_check (migration
// contact_preferences); tests/unit/contact-preferences.test.ts reads the migration and compares.
// Display only: nothing sends by them yet (HEB-07 and the sending modules will).

export const CONTACT_LOCALES = ["he", "ar", "en", "ru", "am", "fr", "es"] as const;
export type ContactLocale = (typeof CONTACT_LOCALES)[number];

export const CONTACT_LOCALE_LABELS: Record<ContactLocale, string> = {
  he: "עברית",
  ar: "ערבית",
  en: "אנגלית",
  ru: "רוסית",
  am: "אמהרית",
  fr: "צרפתית",
  es: "ספרדית",
};

export const CONTACT_CHANNELS = ["phone", "whatsapp", "email", "sms"] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

export const CONTACT_CHANNEL_LABELS: Record<ContactChannel, string> = {
  phone: "טלפון",
  whatsapp: "וואטסאפ",
  email: "אימייל",
  sms: "SMS",
};

export function isContactLocale(value: unknown): value is ContactLocale {
  return typeof value === "string" && (CONTACT_LOCALES as readonly string[]).includes(value);
}

export function isContactChannel(value: unknown): value is ContactChannel {
  return typeof value === "string" && (CONTACT_CHANNELS as readonly string[]).includes(value);
}

/** The Hebrew name of a stored language, or null for none / an unknown one. */
export function localeLabel(value: string | null | undefined): string | null {
  return isContactLocale(value) ? CONTACT_LOCALE_LABELS[value] : null;
}

/** The Hebrew name of a stored channel, or null for none / an unknown one. */
export function channelLabel(value: string | null | undefined): string | null {
  return isContactChannel(value) ? CONTACT_CHANNEL_LABELS[value] : null;
}

export const LOCALE_OPTIONS = CONTACT_LOCALES.map((value) => ({ value, label: CONTACT_LOCALE_LABELS[value] }));
export const CHANNEL_OPTIONS = CONTACT_CHANNELS.map((value) => ({ value, label: CONTACT_CHANNEL_LABELS[value] }));

/** The preferred channel as the contact buttons take it, or null when none is set. */
export function preferredContactChannel(value: string | null | undefined): { channel: ContactChannel; label: string } | null {
  return isContactChannel(value) ? { channel: value, label: CONTACT_CHANNEL_LABELS[value] } : null;
}
