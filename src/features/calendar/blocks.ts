import { z } from "zod";

import type { CalendarSettings } from "@/features/calendar-days/holidays";
import { restDayIssues, type RestDayIssue } from "@/features/meetings/conflicts";
import type { ActionResult } from "@/lib/action-result";
import { isCalendarDate } from "@/lib/calendar-date";
import { longDay } from "@/lib/calendar-grid";
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

// GAP-07 (owner, 18 October 2026): a weekly recurring block, made with the CAL-09 series mechanism
// (public.create_meeting_series with is_block, migration 021060): 2..52 blocks, each its own row.

/** "חסימה 3 בסדרה שבועית" */
export function blockSeriesLabel(index: number): string {
  return `חסימה ${index} בסדרה שבועית`;
}

/** The series fields create_meeting_series takes for blocks; `ownerId` keeps someone else's series theirs on a split. */
export function blockSeriesFields(title: string, ownerId: string | null = null) {
  return {
    title,
    ...BLOCK_ROW_SHAPE,
    meeting_type_id: null,
    lead_id: null,
    contact_id: null,
    company_id: null,
    deal_id: null,
    ...(ownerId ? { owner_id: ownerId } : {}),
  };
}

/** The blocks a "this and following" change or release could not reach: no permission, or a failed write. */
export type SkippedBlocks = { forbidden: string[]; failed: string[] };

/** One sentence per reason, first ten dates named, then "ועוד N"; null when every block was reached. */
export function skippedBlockDatesText(skipped: SkippedBlocks, action: "change" | "release"): string | null {
  const part = (dates: readonly string[], reason: string) => {
    if (dates.length === 0) return null;
    const sorted = [...dates].sort();
    const shown = sorted.slice(0, 10).map(longDay).join("; ");
    const more = sorted.length - 10;
    const head =
      action === "change"
        ? sorted.length === 1 ? "חסימה אחת לא השתנתה" : `${sorted.length} חסימות לא השתנו`
        : sorted.length === 1 ? "חסימה אחת לא שוחררה" : `${sorted.length} חסימות לא שוחררו`;
    return `${head}, ${reason}: ${shown}${more > 0 ? `; ועוד ${more}` : ""}.`;
  };
  const lines = [part(skipped.forbidden, "אין הרשאה"), part(skipped.failed, "שגיאה בשמירה, נסו שוב")].filter((line): line is string => line !== null);
  return lines.length > 0 ? lines.join(" ") : null;
}

/** The confirmation text before freeing this block and the following ones. */
export function releaseFollowingText(count: number): string {
  const what = count === 1 ? "הזמן החסום הזה ישוחרר" : `${count} חסימות ישוחררו, מהחסימה הזו ואילך`;
  return `${what}, והזמן יחזור להיות פנוי, גם בדף קביעת התור. חסימות שכבר עברו לא משתנות.`;
}

/** The confirmation text when "this and following" moves to another weekday (the series is made again). */
export function blockSplitText(total: number, startDay: string): string {
  return `${total === 1 ? "החסימה" : `${total} החסימות`} מהחסימה הזו והלאה יימחקו ויחסמו מחדש כסדרה חדשה, החל מ${startDay}. חסימות שכבר עברו לא משתנות.`;
}

/** Every rest day or holiday of the business the blocks fall on, each day once, in date order (a warning only). */
export function blockRestDays(spans: ReadonlyArray<{ starts_at: string; ends_at: string }>, settings: CalendarSettings, timeZone: string): RestDayIssue[] {
  const days = new Map<string, RestDayIssue>();
  for (const span of spans) {
    for (const issue of restDayIssues({ startsAt: span.starts_at, endsAt: span.ends_at }, settings, timeZone)) days.set(issue.day, issue);
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * The block form's state: a failure may carry the rest days a series falls on (asked once, field `rest_ok`) or the
 * question before "this and following" moves to another weekday (field `split_ok`).
 */
export type BlockFormState = (ActionResult & { restDays?: RestDayIssue[]; split?: { text: string } }) | null;

export const BLOCK_REST_MESSAGE = "חלק מהחסימות נופלות על ימי מנוחה של העסק. אפשר לחסום בכל זאת.";
