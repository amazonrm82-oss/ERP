import { z } from "zod";

import { optionalDate, requiredText } from "@/lib/validation";

export const createTaskSchema = z.object({
  title: requiredText(300, "יש לכתוב מה צריך לעשות.", "הכותרת ארוכה מדי (עד 300 תווים)."),
  due_date: optionalDate,
});
