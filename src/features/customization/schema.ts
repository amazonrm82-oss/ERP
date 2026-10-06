import { z } from "zod";

import { checkbox, requiredText } from "@/lib/validation";

export const STAGE_KINDS = ["open", "won", "lost"] as const;
export const STATUS_KINDS = ["open", "converted", "disqualified"] as const;

export const pipelineNameSchema = z.object({
  name: requiredText(80, "יש להזין שם לפייפליין.", "השם ארוך מדי (עד 80 תווים)."),
});

const probability = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : ""),
  z
    .string()
    .regex(/^\d{1,3}$/, { error: "יש להזין מספר בין 0 ל-100." })
    .transform(Number)
    .refine((value) => value <= 100, { error: "יש להזין מספר בין 0 ל-100." }),
);

export const stageSchema = z.object({
  name: requiredText(80, "יש להזין שם לשלב.", "השם ארוך מדי (עד 80 תווים)."),
  kind: z.enum(STAGE_KINDS, { error: "יש לבחור סוג שלב." }),
  probability,
});

export const statusSchema = z.object({
  name: requiredText(60, "יש להזין שם לסטטוס.", "השם ארוך מדי (עד 60 תווים)."),
  kind: z.enum(STATUS_KINDS, { error: "יש לבחור סוג סטטוס." }),
});

export const sourceSchema = z.object({
  name: requiredText(60, "יש להזין שם למקור.", "השם ארוך מדי (עד 60 תווים)."),
});

export const tagSchema = z.object({
  name: requiredText(40, "יש להזין שם לתגית.", "השם ארוך מדי (עד 40 תווים)."),
});

export const activeSchema = z.object({ is_active: checkbox });
