import { z } from "zod";

import type { MeetingStatus, MeetingType } from "@/lib/database.types";
import { zonedIso } from "@/lib/format";
import { optionalText, requiredText } from "@/lib/validation";
import { isCalendarDate } from "@/lib/calendar-date";

// CAL-01: a meeting as its own record.

export const MEETING_TYPES = ["in_person", "phone", "video", "other"] as const satisfies readonly MeetingType[];
export const MEETING_STATUSES = ["planned", "held", "cancelled", "no_show"] as const satisfies readonly MeetingStatus[];

export const MEETING_TYPE_OPTIONS: { value: MeetingType; label: string }[] = [
  { value: "in_person", label: "פגישה פנים אל פנים" },
  { value: "phone", label: "שיחת טלפון" },
  { value: "video", label: "שיחת וידאו" },
  { value: "other", label: "אחר" },
];

export const MEETING_STATUS_OPTIONS: { value: MeetingStatus; label: string }[] = [
  { value: "planned", label: "מתוכננת" },
  { value: "held", label: "התקיימה" },
  { value: "cancelled", label: "בוטלה" },
  { value: "no_show", label: "הלקוח לא הגיע" },
];

export const MEETING_TYPE_LABEL: Record<string, string> = Object.fromEntries(MEETING_TYPE_OPTIONS.map((o) => [o.value, o.label]));
export const MEETING_STATUS_LABEL: Record<string, string> = Object.fromEntries(MEETING_STATUS_OPTIONS.map((o) => [o.value, o.label]));

// CAL-06: how long before the start the team is reminded, in the bell and by push; "none" = no reminder
export const MEETING_REMINDER_OPTIONS = [
  { value: "none", label: "בלי תזכורת" },
  { value: "5", label: "5 דקות לפני" },
  { value: "15", label: "15 דקות לפני" },
  { value: "30", label: "30 דקות לפני" },
  { value: "60", label: "שעה לפני" },
  { value: "1440", label: "יום לפני" },
] as const;
export type MeetingReminderValue = (typeof MEETING_REMINDER_OPTIONS)[number]["value"];
export const DEFAULT_MEETING_REMINDER: MeetingReminderValue = "15";
const REMINDER_VALUES = MEETING_REMINDER_OPTIONS.map((o) => o.value) as [MeetingReminderValue, ...MeetingReminderValue[]];

/** The form's choice for a stored reminder (minutes, or null for none); an unknown value shows the default. */
export function reminderChoice(minutes: number | null): MeetingReminderValue {
  if (minutes === null) return "none";
  return REMINDER_VALUES.find((value) => value === String(minutes)) ?? DEFAULT_MEETING_REMINDER;
}

export const MEETING_FIELD_NAMES = [
  "title",
  "meeting_type",
  "date",
  "start_time",
  "end_time",
  "location",
  "video_url",
  "description",
  "reminder_minutes",
] as const;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const requiredTime = (missing: string) =>
  z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string().min(1, { error: missing }).regex(TIME_RE, { error: "השעה אינה תקינה." }));

const httpUrl = optionalText(2000, "הקישור ארוך מדי.").refine(
  (value) => {
    if (value === null) return true;
    try {
      const url = new URL(value);
      return (url.protocol === "https:" || url.protocol === "http:") && !/\s/.test(value);
    } catch {
      return false;
    }
  },
  { error: "יש להדביק קישור מלא שמתחיל ב-https://" },
);

export const meetingSchema = z
  .object({
    title: requiredText(300, "יש לכתוב כותרת לפגישה.", "הכותרת ארוכה מדי (עד 300 תווים)."),
    meeting_type: z.enum(MEETING_TYPES, { error: "יש לבחור סוג פגישה." }),
    date: z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string().refine(isCalendarDate, { error: "יש לבחור תאריך." })),
    start_time: requiredTime("יש לבחור שעת התחלה."),
    end_time: requiredTime("יש לבחור שעת סיום."),
    location: optionalText(500, "המיקום ארוך מדי (עד 500 תווים)."),
    video_url: httpUrl,
    description: optionalText(5000, "התיאור ארוך מדי (עד 5,000 תווים)."),
    // a form without the field keeps the default
    reminder_minutes: z
      .preprocess((value) => (typeof value === "string" && value !== "" ? value : DEFAULT_MEETING_REMINDER), z.enum(REMINDER_VALUES, { error: "יש לבחור מתי להזכיר." }))
      .transform((value) => (value === "none" ? null : Number(value))),
  })
  // "HH:MM" strings compare in time order
  .refine((m) => m.end_time > m.start_time, { path: ["end_time"], error: "שעת הסיום צריכה להיות אחרי שעת ההתחלה." });

export type MeetingInput = z.infer<typeof meetingSchema>;

export const meetingStatusSchema = z.object({
  status: z.enum(MEETING_STATUSES, { error: "יש לבחור סטטוס." }),
  outcome: optionalText(5000, "התוצאה ארוכה מדי (עד 5,000 תווים)."),
});

/** The participants picked in the form: distinct ids, at most 50. */
export const participantIdsSchema = z.array(z.guid()).max(50).transform((ids) => [...new Set(ids)]);

/**
 * Start and end of a meeting as UTC instants, from a calendar date and two
 * wall-clock times in the organization's zone. The offset is taken at each
 * instant, so a meeting on a clock-change day lands at the right hour.
 */
export function meetingTimes(date: string, startTime: string, endTime: string, timeZone: string): { starts_at: string; ends_at: string } {
  return { starts_at: zonedIso(date, `${startTime}:00`, timeZone), ends_at: zonedIso(date, `${endTime}:00`, timeZone) };
}

/** Upcoming first (soonest first), then past (latest first). "Upcoming" = has not ended yet. */
export function splitMeetings<T extends { endsAt: string; startsAt: string }>(meetings: T[], now: Date): { upcoming: T[]; past: T[] } {
  const at = now.getTime();
  const upcoming = meetings.filter((m) => Date.parse(m.endsAt) > at).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const past = meetings.filter((m) => Date.parse(m.endsAt) <= at).sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));
  return { upcoming, past };
}
