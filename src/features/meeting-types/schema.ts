import { z } from "zod";

import { STAGE_COLOR_VALUES, stageColor, type StageColor } from "@/features/deals/stage-colors";
import { MEETING_TYPES } from "@/features/meetings/schema";
import type { MeetingType } from "@/lib/database.types";
import { checkbox, optionalId, optionalText, requiredText } from "@/lib/validation";

// CAL-08: the kinds of meeting a business holds (managed list, public.meeting_types).
// The limits mirror the table's checks in migration meeting_types.

export const MEETING_TYPE_NAME_MAX = 80;
export const MEETING_TYPE_LOCATION_MAX = 500;
export const DURATION_MIN = 5;
export const DURATION_MAX = 720;
export const BUFFER_MAX = 240;
// the database refuses more (trigger meeting_types_cap, hint 'meeting_types:max')
export const MEETING_TYPES_PER_ORG = 50;

/**
 * Every organization starts with these and renames or deletes them freely; the database seeds them
 * (app.seed_meeting_types); tests/db/99-meeting-types.test.ts keeps the two equal.
 */
export const DEFAULT_MEETING_TYPES: readonly { name: string; minutes: number; format: MeetingType; color: StageColor }[] = [
  { name: "פגישת היכרות", minutes: 30, format: "in_person", color: "accent" },
  { name: "פגישת מכירה", minutes: 60, format: "in_person", color: "success" },
  { name: "שיחת טלפון", minutes: 15, format: "phone", color: "warning" },
  // the next palette colour the other three do not use (owner, 15 October 2026)
  { name: "שיחת וידאו", minutes: 30, format: "video", color: "danger" },
];

/** A meeting type as the forms use it. */
export type MeetingTypeChoice = {
  id: string;
  name: string;
  durationMinutes: number;
  // how it is held (in_person, phone…); null = not set
  format: MeetingType | null;
  location: string | null;
  bufferBefore: number;
  bufferAfter: number;
  color: StageColor | null;
  isActive: boolean;
};

export function isMeetingFormat(value: unknown): value is MeetingType {
  return typeof value === "string" && (MEETING_TYPES as readonly string[]).includes(value);
}

/** The stored colour when it is a palette key, else null (no colour). */
export const meetingTypeColor = (value: string | null | undefined): StageColor | null => stageColor(value);

const minutes = (min: number, max: number, label: string) =>
  z.preprocess(
    (value) => (typeof value === "string" ? value.trim() : value),
    z
      .string()
      .min(1, { error: `יש להזין ${label}.` })
      .regex(/^\d+$/, { error: `${label} בדקות שלמות.` })
      .transform(Number)
      .pipe(z.number().min(min, { error: `${label}: לפחות ${min} דקות.` }).max(max, { error: `${label}: עד ${max} דקות.` })),
  );

const optionalMinutes = (label: string) =>
  z.preprocess((value) => (typeof value === "string" && value.trim() !== "" ? value : "0"), minutes(0, BUFFER_MAX, label));

export const meetingTypeSchema = z.object({
  name: requiredText(MEETING_TYPE_NAME_MAX, "יש להזין שם לסוג הפגישה.", `השם ארוך מדי (עד ${MEETING_TYPE_NAME_MAX} תווים).`),
  duration_minutes: minutes(DURATION_MIN, DURATION_MAX, "משך"),
  meeting_format: z
    .preprocess((value) => (typeof value === "string" ? value : ""), z.union([z.literal(""), z.enum(MEETING_TYPES)]))
    .transform((value) => (value === "" ? null : value)),
  location: optionalText(MEETING_TYPE_LOCATION_MAX, `המיקום ארוך מדי (עד ${MEETING_TYPE_LOCATION_MAX} תווים).`),
  // absent when the plan has no products: the action then leaves the stored link alone
  product_id: optionalId,
  buffer_before_minutes: optionalMinutes("מרווח לפני"),
  buffer_after_minutes: optionalMinutes("מרווח אחרי"),
  color: z
    .preprocess((value) => (typeof value === "string" ? value : ""), z.union([z.literal(""), z.enum(STAGE_COLOR_VALUES)]))
    .transform((value) => (value === "" ? null : value)),
  is_active: checkbox,
});

export const MEETING_TYPE_FIELD_NAMES = [
  "name",
  "duration_minutes",
  "meeting_format",
  "location",
  "product_id",
  "buffer_before_minutes",
  "buffer_after_minutes",
  "color",
  "is_active",
] as const;

export type MeetingTypeInput = z.infer<typeof meetingTypeSchema>;

/** "1:30 שעות", "45 דקות", "שעה": a duration in plain Hebrew. */
export function durationText(total: number): string {
  if (total < 60) return `${total} דקות`;
  if (total === 60) return "שעה";
  if (total === 120) return "שעתיים";
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${hours} שעות` : `${hours}:${String(rest).padStart(2, "0")} שעות`;
}

/** The buffers in a short line, or null when there are none. */
export function buffersText(before: number, after: number): string | null {
  const parts = [before > 0 ? `${before} דק׳ לפני` : null, after > 0 ? `${after} דק׳ אחרי` : null].filter(Boolean);
  return parts.length > 0 ? `מרווח ${parts.join(" ו-")}` : null;
}

/** "HH:MM" plus some minutes, capped at 23:59 (a meeting in the form stays on one day). */
export function timeAfter(time: string, add: number): string {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return time;
  const total = Number(match[1]) * 60 + Number(match[2]) + add;
  if (total >= 24 * 60) return "23:59";
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

type FormFill = { title: string; format: string; location: string; endTime: string };

/**
 * What the meeting form shows after a type is picked (CAL-08). The end follows the type's duration;
 * the format follows the type when it sets one; the title and the location are filled only while
 * they are empty or still hold what the previous type filled in, so nothing the person typed is lost.
 * No type picked (null): everything stays.
 */
export function fillFromType(previous: MeetingTypeChoice | null, next: MeetingTypeChoice | null, current: FormFill & { startTime: string }): FormFill {
  const { startTime, ...kept } = current;
  if (!next) return kept;
  const untouched = (value: string, before: string | null | undefined) => value.trim() === "" || value === (before ?? "");
  return {
    title: untouched(current.title, previous?.name) ? next.name : current.title,
    format: next.format ?? current.format,
    location: untouched(current.location, previous?.location) ? (next.location ?? "") : current.location,
    endTime: timeAfter(startTime, next.durationMinutes),
  };
}

/**
 * The types a meeting form offers: the active ones, and the meeting's own type even when it was
 * hidden later (the database lets a meeting keep it).
 */
export function offeredTypes(types: readonly MeetingTypeChoice[], currentId: string | null | undefined): MeetingTypeChoice[] {
  return types.filter((type) => type.isActive || type.id === currentId);
}
