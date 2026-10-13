import { z } from "zod";

import { BREACH_ACTIONS, TARGET_MAX, TARGET_MIN } from "./settings";

export const RESPONSE_FIELD_NAMES = ["target_minutes", "breach_action"] as const;

const TARGET_RANGE = `יעד בין ${TARGET_MIN} ל-${TARGET_MAX} דקות.`;

/** The response target form (CAP-10): whole minutes in range, and one of the actions. */
export const responseSettingsSchema = z.object({
  target_minutes: z.preprocess(
    (value) => (typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : undefined),
    z.number({ error: "יש לכתוב יעד בדקות." }).int({ error: "יעד בדקות שלמות." }).min(TARGET_MIN, { error: TARGET_RANGE }).max(TARGET_MAX, { error: TARGET_RANGE }),
  ),
  breach_action: z.enum(BREACH_ACTIONS, { error: "יש לבחור מה קורה בחריגה." }),
});

export type ResponseSettingsInput = z.infer<typeof responseSettingsSchema>;
