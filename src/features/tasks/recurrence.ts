import { z } from "zod";

import { addDays, weekday, WEEKDAYS_SHORT } from "@/lib/calendar-grid";
import { isCalendarDate } from "@/lib/calendar-date";
import { TIME_ZONE } from "@/lib/app";
import { zoneDate, zonedIso, zoneTime } from "@/lib/format";

/**
 * Recurring tasks (TASK-04). The rule is stored in tasks.recurrence; the shape
 * is checked by constraint tasks_recurrence_shape and the next task is created
 * by app.spawn_recurring_task() (migration 20261006006300). This file mirrors
 * both: keep the three in step.
 */

const until = z.string().refine(isCalendarDate);
const left = z.number().int().min(1).max(999);
const end = { until: until.optional(), left: left.optional() };

export const recurrenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("daily"), ...end }),
  z.strictObject({ kind: z.literal("weekly"), weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7), ...end }),
  z.strictObject({ kind: z.literal("monthly"), day: z.number().int().min(1).max(31), ...end }),
  z.strictObject({ kind: z.literal("after_done"), days: z.number().int().min(1).max(365), ...end }),
]);

export type Recurrence = z.infer<typeof recurrenceSchema>;
export type RecurrenceKind = Recurrence["kind"];

/** The stored rule, or null for a one-off task (or a value that is not a rule). */
export function parseRecurrence(value: unknown): Recurrence | null {
  const parsed = recurrenceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** The next date of the rule strictly after `after` (both "YYYY-MM-DD"). */
export function nextDate(rule: Recurrence, after: string): string {
  switch (rule.kind) {
    case "daily":
      return addDays(after, 1);
    case "weekly": {
      for (let i = 1; i <= 7; i++) {
        const day = addDays(after, i);
        if (rule.weekdays.includes(weekday(day))) return day;
      }
      // unreachable: the schema demands at least one weekday
      return addDays(after, 7);
    }
    case "monthly": {
      const [year, month] = after.split("-").map(Number);
      for (let i = 0; i <= 1; i++) {
        const y = year + Math.floor((month - 1 + i) / 12);
        const m = (month - 1 + i) % 12;
        const day = Math.min(rule.day, lastDayOfMonth(y, m));
        const candidate = `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        if (candidate > after) return candidate;
      }
      return after;
    }
    case "after_done":
      return addDays(after, rule.days);
  }
}

export type NextTask = { dueAt: string; remindAt: string | null; recurrence: Recurrence | null };

/**
 * The task that completing this one creates, or null when the series ends.
 * Same local time of day in the zone; a fixed schedule never lands before today;
 * a task without a due date counts from today at 09:00.
 */
export function nextTask(
  rule: Recurrence,
  task: { dueAt: string | null; remindAt: string | null },
  now: Date = new Date(),
  timeZone: string = TIME_ZONE,
): NextTask | null {
  const today = zoneDate(now, timeZone);
  const from = task.dueAt ? zoneDate(new Date(task.dueAt), timeZone) : today;
  const time = task.dueAt ? zoneTime(new Date(task.dueAt), timeZone) : "09:00";

  let next: string;
  if (rule.kind === "after_done") {
    next = nextDate(rule, today);
  } else {
    next = nextDate(rule, from);
    for (let steps = 0; next < today && steps < 5000; steps++) next = nextDate(rule, next);
  }
  if (rule.until && next > rule.until) return null;

  let recurrence: Recurrence | null = rule;
  if (rule.left !== undefined) recurrence = rule.left <= 1 ? null : { ...rule, left: rule.left - 1 };

  const dueAt = zonedIso(next, `${time}:00`, timeZone);
  const remindAt = task.dueAt && task.remindAt ? new Date(Date.parse(dueAt) - (Date.parse(task.dueAt) - Date.parse(task.remindAt))).toISOString() : null;
  return { dueAt, remindAt, recurrence };
}

function weekdaysText(days: number[]): string {
  return [...days].sort((a, b) => a - b).map((d) => WEEKDAYS_SHORT[d]).join(", ");
}

/** "כל יום", "כל שבוע בימים א׳, ד׳", "כל חודש ב-15", "3 ימים אחרי ההשלמה", with the end. */
export function describeRecurrence(rule: Recurrence): string {
  let text: string;
  switch (rule.kind) {
    case "daily":
      text = "כל יום";
      break;
    case "weekly":
      text = rule.weekdays.length === 7 ? "כל יום בשבוע" : `כל שבוע ${rule.weekdays.length === 1 ? "ביום" : "בימים"} ${weekdaysText(rule.weekdays)}`;
      break;
    case "monthly":
      text = rule.day >= 29 ? `כל חודש ב-${rule.day} (או ביום האחרון של החודש)` : `כל חודש ב-${rule.day}`;
      break;
    case "after_done":
      text = rule.days === 1 ? "יום אחרי ההשלמה" : `${rule.days} ימים אחרי ההשלמה`;
      break;
  }
  if (rule.until) {
    const [y, m, d] = rule.until.split("-");
    text += `, עד ${Number(d)}.${Number(m)}.${y}`;
  }
  if (rule.left !== undefined) text += rule.left === 1 ? ", עוד פעם אחת" : `, עוד ${rule.left} פעמים`;
  return text;
}

// ---------------------------------------------------------------------------
// The form ("חזרה" in the task form)
// ---------------------------------------------------------------------------

export const REPEAT_FIELD_NAMES = ["repeat", "repeat_weekdays", "repeat_day", "repeat_days", "repeat_end", "repeat_until", "repeat_count"] as const;

export type RepeatValues = Partial<Record<(typeof REPEAT_FIELD_NAMES)[number], string | null>>;

const text = z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string());
const wholeNumber = (min: number, max: number, message: string) =>
  text.refine((value) => /^\d{1,3}$/.test(value) && Number(value) >= min && Number(value) <= max, { error: message }).transform(Number);

/**
 * The repeat fields of the form, as a rule (null = no repeat). Fields that the
 * chosen kind does not use are ignored, so a hidden field cannot fail the form.
 */
export const repeatFormSchema = z
  .object({
    repeat: z.preprocess((value) => (value === null || value === undefined || value === "" ? "none" : value), z.enum(["none", "daily", "weekly", "monthly", "after_done"], { error: "יש לבחור איך המשימה חוזרת." })),
    repeat_weekdays: text,
    repeat_day: text,
    repeat_days: text,
    repeat_end: z.preprocess((value) => (value === null || value === undefined || value === "" ? "never" : value), z.enum(["never", "until", "count"], { error: "יש לבחור מתי החזרה נגמרת." })),
    repeat_until: text,
    repeat_count: text,
  })
  .transform((form, ctx): Recurrence | null => {
    if (form.repeat === "none") return null;
    const issue = (path: string, message: string) => {
      ctx.addIssue({ code: "custom", path: [path], message });
      return z.NEVER;
    };
    let rule: Recurrence;
    switch (form.repeat) {
      case "daily":
        rule = { kind: "daily" };
        break;
      case "weekly": {
        const days = form.repeat_weekdays === "" ? [] : form.repeat_weekdays.split(",");
        if (days.length === 0 || days.some((d) => !/^[0-6]$/.test(d))) return issue("repeat_weekdays", "יש לבחור לפחות יום אחד בשבוע.");
        rule = { kind: "weekly", weekdays: [...new Set(days.map(Number))].sort((a, b) => a - b) };
        break;
      }
      case "monthly": {
        const day = wholeNumber(1, 31, "יש לבחור יום בחודש, מ-1 עד 31.").safeParse(form.repeat_day);
        if (!day.success) return issue("repeat_day", "יש לבחור יום בחודש, מ-1 עד 31.");
        rule = { kind: "monthly", day: day.data };
        break;
      }
      case "after_done": {
        const days = wholeNumber(1, 365, "יש לכתוב מספר ימים, מ-1 עד 365.").safeParse(form.repeat_days);
        if (!days.success) return issue("repeat_days", "יש לכתוב מספר ימים, מ-1 עד 365.");
        rule = { kind: "after_done", days: days.data };
        break;
      }
    }
    if (form.repeat_end === "until") {
      if (!isCalendarDate(form.repeat_until)) return issue("repeat_until", "יש לבחור תאריך סיום.");
      rule.until = form.repeat_until;
    } else if (form.repeat_end === "count") {
      const count = wholeNumber(1, 999, "יש לכתוב מספר פעמים, מ-1 עד 999.").safeParse(form.repeat_count);
      if (!count.success) return issue("repeat_count", "יש לכתוב מספר פעמים, מ-1 עד 999.");
      rule.left = count.data;
    }
    return rule;
  });

/** A saved rule as the form's values (for the edit form). */
export function repeatValues(rule: Recurrence | null): RepeatValues {
  if (!rule) return { repeat: "none" };
  return {
    repeat: rule.kind,
    repeat_weekdays: rule.kind === "weekly" ? rule.weekdays.join(",") : "",
    repeat_day: rule.kind === "monthly" ? String(rule.day) : "",
    repeat_days: rule.kind === "after_done" ? String(rule.days) : "",
    repeat_end: rule.until ? "until" : rule.left !== undefined ? "count" : "never",
    repeat_until: rule.until ?? "",
    repeat_count: rule.left !== undefined ? String(rule.left) : "",
  };
}
