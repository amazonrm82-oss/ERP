import { z } from "zod";

import { isCalendarDate } from "@/lib/calendar-date";
import { optionalText } from "@/lib/validation";

// GAP-07: blocked time in the calendar. A block is a meeting row with is_block (migration 020115): the booking page and
// the conflict warnings treat it as taken; it has no record, type, reminder or buffers and is never held or a no-show.

export const BLOCK_DEFAULT_TITLE = "זמן חסום";
export const BLOCK_FIELD_NAMES = ["title", "date", "start_time", "end_time"] as const;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const time = (missing: string) =>
  z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string().min(1, { error: missing }).regex(TIME_RE, { error: "השעה אינה תקינה." }));

export const blockSchema = z
  .object({
    // empty = "זמן חסום"
    title: optionalText(300, "התיאור ארוך מדי (עד 300 תווים).").transform((value) => value ?? BLOCK_DEFAULT_TITLE),
    date: z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string().refine(isCalendarDate, { error: "יש לבחור תאריך." })),
    start_time: time("יש לבחור שעת התחלה."),
    end_time: time("יש לבחור שעת סיום."),
  })
  // "HH:MM" strings compare in time order
  .refine((b) => b.end_time > b.start_time, { path: ["end_time"], error: "שעת הסיום צריכה להיות אחרי שעת ההתחלה." });

export type BlockInput = z.infer<typeof blockSchema>;

/** The fixed shape of a block row (the database refuses anything else, constraint meetings_block_shape). */
export const BLOCK_ROW_SHAPE = {
  is_block: true,
  meeting_type: "other",
  reminder_minutes: null,
  buffer_before_minutes: 0,
  buffer_after_minutes: 0,
} as const;
