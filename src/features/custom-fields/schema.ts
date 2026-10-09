import { z } from "zod";

import { checkbox, optionalText, requiredText } from "@/lib/validation";

import { FIELD_OBJECTS, FIELD_TYPES, TYPES_WITH_OPTIONS } from "./types";

/** One choice per line; blank lines and repeats dropped. */
const optionLines = z.preprocess(
  (value) => (typeof value === "string" ? value : ""),
  z
    .string()
    .transform((text) => [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))])
    .pipe(
      z
        .array(z.string().max(100, { error: "כל אפשרות עד 100 תווים." }))
        .max(100, { error: "עד 100 אפשרויות." }),
    ),
);

const fieldFields = {
  label: requiredText(80, "יש להזין שם לשדה.", "השם ארוך מדי (עד 80 תווים)."),
  options: optionLines,
  help_text: optionalText(200, "ההסבר ארוך מדי (עד 200 תווים)."),
  is_required: checkbox,
};

export const createFieldSchema = z
  .object({
    ...fieldFields,
    object_type: z.enum(FIELD_OBJECTS),
    field_type: z.enum(FIELD_TYPES, { error: "יש לבחור סוג שדה." }),
  })
  .refine((field) => !TYPES_WITH_OPTIONS.includes(field.field_type) || field.options.length > 0, {
    path: ["options"],
    error: "יש לכתוב לפחות אפשרות אחת, כל אחת בשורה.",
  });

export const updateFieldSchema = z.object(fieldFields);
