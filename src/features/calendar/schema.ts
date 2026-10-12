import { z } from "zod";

import { isCalendarDate } from "@/lib/calendar-date";

// CAL-02: where an item moves to, from a drag or from the "move" form:
// a day and a wall-clock time in the organization's zone.
export const moveTargetSchema = z
  .object({
    kind: z.enum(["meeting", "task"]),
    date: z.string().refine(isCalendarDate),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  })
  .strict();

export type MoveTarget = z.infer<typeof moveTargetSchema>;
