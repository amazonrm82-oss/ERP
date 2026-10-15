// CAP-08 (owner, 14 October 2026): a public form may ask the person's preferred language.
// forms.locale_choice turns it on; intake_form() returns `locale_choice`; the hosted form sends
// one of the contacts' codes as `preferred_locale`; intake_submit() keeps it on a new lead and fills
// an existing lead or contact only when theirs is empty. Distribution rules may use it.

import { isContactLocale, LOCALE_OPTIONS, type ContactLocale } from "@/features/contacts/preferences";

/** The input's name on the hosted form, and the payload key intake_submit() reads. */
export const LOCALE_INPUT = "preferred_locale";

export const LOCALE_QUESTION = "באיזו שפה נוח לך לדבר?";

export const PUBLIC_LOCALE_OPTIONS = LOCALE_OPTIONS;

/** A sent value as a language code, or null for none or anything outside the list. */
export function localeInput(value: string | null | undefined): ContactLocale | null {
  const trimmed = value?.trim();
  return isContactLocale(trimmed) ? trimmed : null;
}
