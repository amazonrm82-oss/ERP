import { z } from "zod";

import { BREACH_ACTIONS, PASSES_MAX, PASSES_MIN, TARGET_MAX, TARGET_MIN } from "./settings";

export const RESPONSE_FIELD_NAMES = ["target_minutes", "breach_action", "max_passes"] as const;

const TARGET_RANGE = `יעד בין ${TARGET_MIN} ל-${TARGET_MAX} דקות.`;
const PASSES_RANGE = `בין ${PASSES_MIN} ל-${PASSES_MAX} העברות.`;

const wholeNumber = (missing: string, wholeOnly: string, min: number, max: number, range: string) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : undefined),
    z.number({ error: missing }).int({ error: wholeOnly }).min(min, { error: range }).max(max, { error: range }),
  );

/**
 * The response target form (CAP-10): whole minutes in range, and one of the actions.
 * SPD-03: the number of passes, a whole number in range; a form without the field keeps 2.
 */
export const responseSettingsSchema = z.object({
  target_minutes: wholeNumber("יש לכתוב יעד בדקות.", "יעד בדקות שלמות.", TARGET_MIN, TARGET_MAX, TARGET_RANGE),
  breach_action: z.enum(BREACH_ACTIONS, { error: "יש לבחור מה קורה בחריגה." }),
  max_passes: wholeNumber("יש לכתוב כמה פעמים להעביר.", "מספר שלם של העברות.", PASSES_MIN, PASSES_MAX, PASSES_RANGE),
});

export type ResponseSettingsInput = z.infer<typeof responseSettingsSchema>;
