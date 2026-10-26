import { z } from "zod";

import { checkbox, optionalText, requiredText } from "@/lib/validation";

import { canBeUnique } from "./settings";
import { FIELD_OBJECTS, FIELD_TYPES, LINK_TARGETS, TYPES_WITH_OPTIONS } from "./types";

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
  // FLD-07 (the default value is read by updateFieldAction with the field's own parser)
  is_unique: checkbox,
  is_read_only: checkbox,
};

export const createFieldSchema = z
  .object({
    ...fieldFields,
    object_type: z.enum(FIELD_OBJECTS),
    field_type: z.enum(FIELD_TYPES, { error: "יש לבחור סוג שדה." }),
    // FLD-06 part B: what a record link points at (only for that type; never changed later)
    link_target: z.preprocess((value) => (value === "" || value === null ? undefined : value), z.enum(LINK_TARGETS).optional()),
  })
  .refine((field) => field.field_type !== "record_link" || field.link_target !== undefined, {
    path: ["link_target"],
    error: "יש לבחור לאיזה סוג רשומה השדה מקשר.",
  })
  .refine((field) => !TYPES_WITH_OPTIONS.includes(field.field_type) || field.options.length > 0, {
    path: ["options"],
    error: "יש לכתוב לפחות אפשרות אחת, כל אחת בשורה.",
  })
  .refine((field) => !field.is_unique || canBeUnique(field.field_type), {
    path: ["is_unique"],
    error: "אפשר להגדיר כייחודי רק שדה מסוג טקסט קצר, מספר, אימייל, טלפון, קישור, תעודת זהות או ח.פ.",
  });

export const updateFieldSchema = z.object(fieldFields);
