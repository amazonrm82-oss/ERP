import { z } from "zod";

import { MAX_ROT_DAYS, STAGE_COLOR_VALUES } from "@/features/deals/stage-colors";
import { STAGE_REQUIRED_FIELDS } from "@/features/deals/stage-required";
import { TAG_COLOR_VALUES } from "@/features/tags/types";

import { checkbox, pick, requiredText } from "@/lib/validation";

export const STAGE_KINDS = ["open", "won", "lost"] as const;
export const STATUS_KINDS = ["open", "converted", "disqualified"] as const;

export const pipelineNameSchema = z.object({
  name: requiredText(80, "יש להזין שם לתהליך המכירה.", "השם ארוך מדי (עד 80 תווים)."),
});

const probability = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : ""),
  z
    .string()
    .regex(/^\d{1,3}$/, { error: "יש להזין מספר בין 0 ל-100." })
    .transform(Number)
    .refine((value) => value <= 100, { error: "יש להזין מספר בין 0 ל-100." }),
);

// DEAL-01: empty means "by the stage's kind"
const stageColorField = z.preprocess(
  (value) => (value === null || value === undefined || value === "" ? null : value),
  z.enum(STAGE_COLOR_VALUES, { error: "יש לבחור צבע מהרשימה." }).nullable(),
);

// DEAL-01: days a deal may sit in the stage; empty means the default (14)
const ROT_DAYS_ERROR = `יש להזין מספר ימים בין 1 ל-${MAX_ROT_DAYS}, או להשאיר ריק.`;
const rotDays = z.preprocess(
  (value) => {
    const text = typeof value === "string" ? value.trim() : "";
    if (text === "") return null;
    return /^\d{1,3}$/.test(text) ? Number(text) : text;
  },
  z
    .number({ error: ROT_DAYS_ERROR })
    .int({ error: ROT_DAYS_ERROR })
    .min(1, { error: ROT_DAYS_ERROR })
    .max(MAX_ROT_DAYS, { error: ROT_DAYS_ERROR })
    .nullable(),
);

export const stageSchema = z.object({
  name: requiredText(80, "יש להזין שם לשלב.", "השם ארוך מדי (עד 80 תווים)."),
  kind: z.enum(STAGE_KINDS, { error: "יש לבחור סוג שלב." }),
  probability,
  color: stageColorField,
  rot_days: rotDays,
  // DEAL-05: the built-in fields a deal must hold to enter the stage; absent (a form without the choices) = unchanged
  required_fields: z
    .array(z.enum(STAGE_REQUIRED_FIELDS, { error: "יש לבחור שדות מהרשימה." }))
    .optional()
    .transform((picked) => (picked === undefined ? undefined : STAGE_REQUIRED_FIELDS.filter((field) => picked.includes(field)))),
});

/** The stage form's values for stageSchema: the plain fields, and the required fields when the form shows them. */
export function stageInput(formData: FormData): Record<string, unknown> {
  const input: Record<string, unknown> = pick(formData, STAGE_FIELDS);
  if (formData.get(STAGE_REQUIRED_SENT) === "1") input.required_fields = formData.getAll("required_fields").filter((value) => typeof value === "string");
  return input;
}

// marks a stage form that shows the required fields (unticked boxes are not sent at all)
export const STAGE_REQUIRED_SENT = "required_fields_sent";

export const STAGE_FIELDS = ["name", "kind", "probability", "color", "rot_days"] as const;

export const statusSchema = z.object({
  name: requiredText(60, "יש להזין שם לסטטוס.", "השם ארוך מדי (עד 60 תווים)."),
  kind: z.enum(STATUS_KINDS, { error: "יש לבחור סוג סטטוס." }),
});

export const sourceSchema = z.object({
  name: requiredText(60, "יש להזין שם למקור.", "השם ארוך מדי (עד 60 תווים)."),
});

export const tagSchema = z.object({
  name: requiredText(40, "יש להזין שם לתגית.", "השם ארוך מדי (עד 40 תווים)."),
  // FLD-02; forms without it leave the colour as it is
  color: z.preprocess((value) => (value === null || value === "" ? undefined : value), z.enum(TAG_COLOR_VALUES, { error: "יש לבחור צבע." }).optional()),
});

export const activeSchema = z.object({ is_active: checkbox });
