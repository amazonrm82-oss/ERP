import { z } from "zod";

import { optionalDate, optionalEmail, optionalId, optionalPhone, optionalText } from "@/lib/validation";

import { CONTACT_CHANNELS, CONTACT_LOCALES } from "./preferences";

export const CONTACT_FIELD_NAMES = [
  "first_name",
  "last_name",
  "phone",
  "email",
  "job_title",
  "company_id",
  "birth_date",
  "preferred_locale",
  "preferred_channel",
] as const;

/** A choice from a closed list: "" (or a missing field) becomes null. */
function optionalChoice<T extends string>(values: readonly T[], message: string) {
  return z
    .preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string())
    .refine((value) => value === "" || (values as readonly string[]).includes(value), { error: message })
    .transform((value) => (value === "" ? null : (value as T)));
}

// The refinement mirrors the contacts_has_identity check constraint.
export const contactSchema = z
  .object({
    first_name: optionalText(100, "השם ארוך מדי (עד 100 תווים)."),
    last_name: optionalText(100, "שם המשפחה ארוך מדי (עד 100 תווים)."),
    phone: optionalPhone,
    email: optionalEmail,
    job_title: optionalText(120, "התפקיד ארוך מדי (עד 120 תווים)."),
    company_id: optionalId,
    birth_date: optionalDate,
    // CON-10
    preferred_locale: optionalChoice(CONTACT_LOCALES, "השפה שנבחרה אינה ברשימה."),
    preferred_channel: optionalChoice(CONTACT_CHANNELS, "הערוץ שנבחר אינו ברשימה."),
  })
  .refine((contact) => Boolean(contact.first_name || contact.last_name || contact.phone || contact.email), {
    path: ["first_name"],
    error: "יש למלא לפחות אחד מהשדות: שם, טלפון או אימייל.",
  });
