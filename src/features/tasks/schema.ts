import { z } from "zod";

import { parseTaskChoice } from "@/features/activity-types/types";
import { optionalDate, optionalId, optionalText, requiredText } from "@/lib/validation";

export const TASK_FIELD_NAMES = ["title", "due_date", "due_time", "owner_id", "task_type", "remind", "priority"] as const;

export const TASK_TYPE_VALUES = ["todo", "call", "meeting", "follow_up"] as const;

// minutes before the due time; "" = no reminder
export const REMIND_VALUES = ["", "0", "15", "60", "1440"] as const;

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
    // the quick-add on the home page does not send it ("משימה"). TASK-08: a fixed code, or a type of the business's list
    // ("t:<id>"), read into the columns to write (parseTaskChoice)
    task_type: z.unknown().transform((value, ctx) => {
      const kind = parseTaskChoice(value);
      if (!kind) {
        ctx.addIssue({ code: "custom", message: "יש לבחור סוג." });
        return z.NEVER;
      }
      return kind;
    }),
    // the quick-add does not send it either
    remind: z.preprocess((value) => value ?? "", z.enum(REMIND_VALUES, { error: "יש לבחור תזכורת." })),
    // 1 high, 2 normal, 3 low (TASK-01); forms without the field keep "normal"
    priority: z.preprocess((value) => (value === null || value === undefined || value === "" ? "2" : value), z.enum(["1", "2", "3"], { error: "יש לבחור עדיפות." })).transform(Number),
  })
  .refine((task) => task.due_time === null || task.due_date !== null, {
    path: ["due_date"],
    error: "כדי לקבוע שעה יש לבחור גם תאריך.",
  })
  .refine((task) => task.remind === "" || task.due_date !== null, {
    path: ["remind"],
    error: "תזכורת צריכה תאריך יעד.",
  });
