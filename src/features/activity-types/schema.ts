import { z } from "zod";

import { requiredText } from "@/lib/validation";

import { ACTIVITY_BASES, ACTIVITY_TYPE_ICONS, ACTIVITY_TYPE_NAME_MAX } from "./types";

const name = requiredText(ACTIVITY_TYPE_NAME_MAX, "יש להזין שם לסוג.", `השם ארוך מדי (עד ${ACTIVITY_TYPE_NAME_MAX} תווים).`);
// "" = the base kind's icon
const icon = z.preprocess((value) => (value === "" || value === null || value === undefined ? null : value), z.enum(ACTIVITY_TYPE_ICONS, { error: "יש לבחור סמל מהרשימה." }).nullable());

// TASK-08: a new type of the business's list: a name under one of the six base kinds
export const newActivityTypeSchema = z.object({
  name,
  base_type: z.enum(ACTIVITY_BASES, { error: "יש לבחור לאיזה סוג בסיסי השם שייך." }),
  icon,
});

// renaming and the icon; the base kind is fixed once the type is saved
export const editActivityTypeSchema = z.object({ name, icon });
