import { z } from "zod";

// CAP-11: the settings forms, as sent. The database checks the same rules again.

const uuidOrNull = z.preprocess((v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null), z.uuid({ error: "הבחירה אינה תקינה." }).nullable());

export const pageIdField = z.string().trim().regex(/^[0-9]{1,40}$/, "מזהה הדף הוא מספר, כפי שהוא מופיע בהגדרות הדף בפייסבוק.");
/** A page token is long plain text; it is encrypted on the server and never shown again. */
export const pageTokenField = z
  .string()
  .trim()
  .min(20, "יש להדביק את טוקן הגישה של הדף.")
  .max(4000, "הטוקן ארוך מדי.")
  .regex(/^[\x21-\x7e]+$/, "הטוקן מכיל תווים לא צפויים. העתיקו אותו שוב.");

export const connectSchema = z.object({
  page_id: pageIdField,
  name: z.string().trim().min(1, "יש לתת שם, למשל שם הדף.").max(120, "עד 120 תווים."),
  token: pageTokenField,
});

export const tokenSchema = z.object({ token: pageTokenField });

export const formMappingSchema = z.object({
  meta_form_id: z.preprocess(
    (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null),
    z.string().regex(/^[0-9]{1,40}$/, "מזהה הטופס הוא מספר, כפי שהוא מופיע בספריית הטפסים של Meta.").nullable(),
  ),
  name: z.string().trim().min(1, "יש לתת שם לטופס.").max(120, "עד 120 תווים."),
  assign_mode: z.enum(["owner", "round_robin"], { error: "יש לבחור למי הולך ליד חדש." }),
  owner_id: uuidOrNull,
  team_id: uuidOrNull,
  is_active: z.boolean(),
});
export type FormMappingInput = z.infer<typeof formMappingSchema>;
