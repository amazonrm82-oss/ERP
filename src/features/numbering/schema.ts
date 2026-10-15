import { z } from "zod";

import { PREFIX_CHARS, PREFIX_MAX, PREFIX_PATTERN, START_MAX, START_MIN } from "./series";

export const SERIES_FIELD_NAMES = ["prefix", "start_number"] as const;

const START_RANGE = `מספר התחלתי בין ${START_MIN} ל-${START_MAX.toLocaleString("en-US")}.`;

/**
 * The series form (QUO-03). The prefix is trimmed; the start is a whole number in range, or
 * missing when the series already handed out a number (the field is not sent then).
 */
export const seriesSchema = z.object({
  prefix: z.preprocess(
    (value) => (typeof value === "string" ? value.trim() : ""),
    z
      .string()
      .max(PREFIX_MAX, { error: `קידומת של עד ${PREFIX_MAX} תווים.` })
      .regex(PREFIX_CHARS, { error: "בקידומת אפשר אותיות, ספרות והסימנים - / . _ בלי רווחים." })
      .regex(PREFIX_PATTERN, { error: "הקידומת לא יכולה להסתיים בספרה. אפשר להוסיף בסופה מקף, למשל Q1-." }),
  ),
  start_number: z.preprocess(
    (value) => (typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : value === null ? undefined : value),
    z
      .number({ error: "יש לכתוב מספר התחלתי." })
      .int({ error: "מספר התחלתי שלם." })
      .min(START_MIN, { error: START_RANGE })
      .max(START_MAX, { error: START_RANGE })
      .optional(),
  ),
});

export type SeriesInput = z.infer<typeof seriesSchema>;
