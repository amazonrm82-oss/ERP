import { z } from "zod";

import { optionalEmail, optionalPhone, optionalText } from "@/lib/validation";

export const CONTACT_FIELD_NAMES = ["first_name", "last_name", "phone", "email", "job_title"] as const;

// The refinement mirrors the contacts_has_identity check constraint.
export const createContactSchema = z
  .object({
    first_name: optionalText(100, "השם ארוך מדי (עד 100 תווים)."),
    last_name: optionalText(100, "שם המשפחה ארוך מדי (עד 100 תווים)."),
    phone: optionalPhone,
    email: optionalEmail,
    job_title: optionalText(120, "התפקיד ארוך מדי (עד 120 תווים)."),
  })
  .refine((contact) => Boolean(contact.first_name || contact.last_name || contact.phone || contact.email), {
    path: ["first_name"],
    error: "יש למלא לפחות אחד מהשדות: שם, טלפון או אימייל.",
  });
