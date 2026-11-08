import { z } from "zod";

import { untilFromInput } from "./hours";

export const SENDING_HOURS_FIELD_NAMES = ["window_from", "window_until", "skip_rest_days"] as const;

const time = (missing: string) =>
  z.preprocess(
    (value) => (typeof value === "string" ? value.trim() : value),
    z.string({ error: missing }).regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, { error: "שעה בצורה 08:00." }),
  );

const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));

/** MSG-06: the window of one day, whole minutes; "00:00" as the end is midnight; the end comes after the start. */
export const sendingHoursSchema = z
  .object({
    window_from: time("יש לבחור שעת התחלה."),
    window_until: time("יש לבחור שעת סיום.").transform(untilFromInput),
    skip_rest_days: z.preprocess((value) => value === "on" || value === "true", z.boolean()),
  })
  .refine((v) => minutes(v.window_until) > minutes(v.window_from), { path: ["window_until"], error: "שעת הסיום צריכה להיות אחרי שעת ההתחלה." });

export type SendingHoursInput = z.infer<typeof sendingHoursSchema>;
