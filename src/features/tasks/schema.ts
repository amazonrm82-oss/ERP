import { z } from "zod";

import { optionalDate, optionalId, optionalText, requiredText } from "@/lib/validation";

export const TASK_FIELD_NAMES = ["title", "due_date", "due_time", "owner_id"] as const;

const optionalTime = optionalText(5).refine((value) => value === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(value), {
  error: "השעה אינה תקינה.",
});

export const taskSchema = z
  .object({
    title: requiredText(300, "יש לכתוב מה צריך לעשות.", "הכותרת ארוכה מדי (עד 300 תווים)."),
    due_date: optionalDate,
    due_time: optionalTime,
    // empty: the task is the creator's (set by the database)
    owner_id: optionalId,
  })
  .refine((task) => task.due_time === null || task.due_date !== null, {
    path: ["due_date"],
    error: "כדי לקבוע שעה יש לבחור גם תאריך.",
  });
