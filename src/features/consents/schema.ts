import { z } from "zod";

import { CONSENT_CHANNELS, LIFT_METHODS, LIFT_NOTE_MAX, MANUAL_STATES, METHOD_MAX, WORDING_MAX } from "./model";

// CNS-03: a manual entry says how the consent was given; the wording is optional.
// An owner's or admin's lift of an opt-out also names how the person asked again and a
// short note (owner, 13 October 2026); the database checks who may lift.
export const manualConsentSchema = z
  .object({
    channel: z.enum(CONSENT_CHANNELS, { error: "בחרו ערוץ." }),
    state: z.enum(MANUAL_STATES, { error: "בחרו מצב." }),
    method: z
      .string()
      .trim()
      .min(1, "צריך לכתוב איך התקבלה ההסכמה.")
      .max(METHOD_MAX, `עד ${METHOD_MAX} תווים.`),
    wording: z
      .string()
      .trim()
      .max(WORDING_MAX, `עד ${WORDING_MAX} תווים.`)
      .transform((value) => (value === "" ? null : value)),
    lift_method: z
      .union([z.enum(LIFT_METHODS), z.literal("")])
      .transform((value) => (value === "" ? null : value)),
    lift_note: z
      .string()
      .trim()
      .max(LIFT_NOTE_MAX, `עד ${LIFT_NOTE_MAX} תווים.`)
      .transform((value) => (value === "" ? null : value)),
  })
  .refine((v) => (v.lift_method === null) === (v.lift_note === null), {
    path: ["lift_note"],
    message: "לביטול הסרה צריך לבחור מקור ולכתוב הערה קצרה.",
  })
  .refine((v) => v.lift_method === null || v.state === "granted", { path: ["lift_method"], message: "ביטול הסרה הוא רק להסכמה." });

export type ManualConsent = z.infer<typeof manualConsentSchema>;
