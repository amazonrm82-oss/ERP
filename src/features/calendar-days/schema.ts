import { z } from "zod";

import { OCCASION_KEYS, restOccasions } from "./holidays";

export const CALENDAR_SETTINGS_FIELDS = ["rest_weekdays", "holidays_rest", "holiday_eves_rest", "rest_occasions"] as const;

/**
 * The settings form: weekly days as checkboxes (0 = Sunday … 6 = Saturday), two on/off choices,
 * and the occasions chosen one by one. No rest day at all is allowed (owner's answer, 12 October 2026).
 */
export const calendarSettingsSchema = z.object({
  rest_weekdays: z
    .array(z.coerce.number().int().min(0).max(6))
    .max(7)
    .transform((days) => [...new Set(days)].sort((a, b) => a - b))
    .refine((days) => days.length < 7, "העסק צריך לעבוד לפחות יום אחד בשבוע."),
  holidays_rest: z.boolean(),
  holiday_eves_rest: z.boolean(),
  rest_occasions: z
    .array(z.enum(OCCASION_KEYS, { message: "אחד המועדים שנבחרו לא מוכר. רעננו את הדף ונסו שוב." }))
    .max(OCCASION_KEYS.length * 2)
    .transform((keys) => restOccasions(keys)),
});

export type CalendarSettingsInput = z.infer<typeof calendarSettingsSchema>;

/** FormData to the schema's input: checkboxes send "on" when checked and nothing otherwise. */
export function calendarSettingsFromForm(formData: FormData) {
  return {
    rest_weekdays: formData.getAll("rest_weekdays").filter((value) => typeof value === "string"),
    holidays_rest: formData.get("holidays_rest") === "on",
    holiday_eves_rest: formData.get("holiday_eves_rest") === "on",
    rest_occasions: formData.getAll("rest_occasions").filter((value) => typeof value === "string"),
  };
}
