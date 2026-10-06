import { z } from "zod";

import { optionalDate, optionalEmail, optionalId, optionalPhone, optionalText } from "@/lib/validation";

export const CONTACT_FIELD_NAMES = ["first_name", "last_name", "phone", "email", "job_title", "company_id", "birth_date"] as const;

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
  })
  .refine((contact) => Boolean(contact.first_name || contact.last_name || contact.phone || contact.email), {
    path: ["first_name"],
    error: "יש למלא לפחות אחד מהשדות: שם, טלפון או אימייל.",
  });
