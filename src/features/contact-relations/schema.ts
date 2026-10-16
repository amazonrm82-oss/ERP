import { z } from "zod";

import { optionalText, requiredId, requiredText } from "@/lib/validation";

import { CONTACT_RELATION_NAME_MAX, parseRelationChoice } from "./types";

const tooLong = `השם ארוך מדי (עד ${CONTACT_RELATION_NAME_MAX} תווים).`;

// CON-06: a type of the business's list: the phrase from the first contact, and optionally from the second
export const relationTypeSchema = z.object({
  name: requiredText(CONTACT_RELATION_NAME_MAX, "יש להזין שם לקשר.", tooLong),
  reverse_name: optionalText(CONTACT_RELATION_NAME_MAX, tooLong),
});

export const RELATION_FIELD_NAMES = ["choice", "other_id"] as const;

// a new relation on a contact's card: the type with this contact's side, and the other contact
export const addRelationSchema = z.object({
  choice: z
    .string({ error: "יש לבחור סוג קשר." })
    .refine((value) => parseRelationChoice(value) !== null, { error: "יש לבחור סוג קשר." })
    .transform((value) => parseRelationChoice(value) as NonNullable<ReturnType<typeof parseRelationChoice>>),
  other_id: requiredId("יש לבחור איש קשר."),
});

export const LEAD_REFERRAL_FIELD_NAMES = ["other_id"] as const;

// a contact this lead referred (the referral type is fixed)
export const leadReferralSchema = z.object({
  other_id: requiredId("יש לבחור איש קשר."),
});
