import { z } from "zod";

import type { BookingQuestion } from "@/lib/database.types";
import { checkbox, optionalId, optionalText, requiredId, requiredText } from "@/lib/validation";

// CAL-10: a booking page's settings, as the settings form sends them. The database checks the same rules again
// (booking_pages constraints and app.booking_pages_check).

export const BOOKING_TITLE_MAX = 120;
export const BOOKING_INTRO_MAX = 1000;
export const BOOKING_QUESTIONS_MAX = 10;
export const BOOKING_QUESTION_MAX = 200;
export const BOOKING_ANSWER_MAX = 1000;

export const MIN_NOTICE_OPTIONS = [
  { value: "0", label: "בלי הגבלה" },
  { value: "60", label: "שעה לפני" },
  { value: "120", label: "שעתיים לפני" },
  { value: "240", label: "4 שעות לפני" },
  { value: "720", label: "12 שעות לפני" },
  { value: "1440", label: "יום לפני" },
  { value: "2880", label: "יומיים לפני" },
] as const;
export const DEFAULT_MIN_NOTICE = "120";

// CAL-10b: up to when the customer may cancel or change online (booking_pages.cancel_notice_hours, 0..72)
export const CANCEL_NOTICE_OPTIONS = [
  { value: "0", label: "עד תחילת הפגישה" },
  { value: "2", label: "עד שעתיים לפני" },
  { value: "4", label: "עד 4 שעות לפני" },
  { value: "12", label: "עד 12 שעות לפני" },
  { value: "24", label: "עד יום לפני" },
  { value: "48", label: "עד יומיים לפני" },
  { value: "72", label: "עד 3 ימים לפני" },
] as const;
export const DEFAULT_CANCEL_NOTICE = "24";
export const CANCEL_NOTICE_MAX = 72;

export const SLOT_STEP_OPTIONS = [
  { value: "15", label: "כל רבע שעה" },
  { value: "30", label: "כל חצי שעה" },
  { value: "60", label: "כל שעה" },
] as const;
export const DEFAULT_SLOT_STEP = "30";

export const MAX_DAYS_AHEAD_MIN = 1;
export const MAX_DAYS_AHEAD_MAX = 365;
export const DEFAULT_MAX_DAYS_AHEAD = 30;

export const BOOKING_FIELD_NAMES = [
  "user_id",
  "title",
  "intro",
  "meeting_type_id",
  "source_id",
  "min_notice_minutes",
  "max_days_ahead",
  "slot_step_minutes",
  "cancel_notice_hours",
  "is_active",
] as const;

const fromList = <T extends readonly { value: string }[]>(options: T, fallback: string, message: string) =>
  z
    .preprocess((value) => (typeof value === "string" && value !== "" ? value : fallback), z.enum(options.map((o) => o.value) as [string, ...string[]], { error: message }))
    .transform(Number);

export const bookingPageSchema = z.object({
  // absent for a member (their own page); an admin may pick the rep
  user_id: optionalId,
  title: requiredText(BOOKING_TITLE_MAX, "יש לכתוב כותרת לדף.", `הכותרת ארוכה מדי (עד ${BOOKING_TITLE_MAX} תווים).`),
  intro: optionalText(BOOKING_INTRO_MAX, `ההסבר ארוך מדי (עד ${BOOKING_INTRO_MAX} תווים).`),
  meeting_type_id: requiredId("יש לבחור סוג פגישה."),
  source_id: optionalId,
  min_notice_minutes: fromList(MIN_NOTICE_OPTIONS, DEFAULT_MIN_NOTICE, "יש לבחור כמה זמן מראש."),
  max_days_ahead: z.preprocess(
    (value) => (typeof value === "string" ? value.trim() : ""),
    z
      .string()
      .regex(/^\d+$/, { error: "יש להזין מספר ימים שלם." })
      .transform(Number)
      .pipe(
        z
          .number()
          .min(MAX_DAYS_AHEAD_MIN, { error: `לפחות ${MAX_DAYS_AHEAD_MIN} יום.` })
          .max(MAX_DAYS_AHEAD_MAX, { error: `עד ${MAX_DAYS_AHEAD_MAX} ימים.` }),
      ),
  ),
  slot_step_minutes: fromList(SLOT_STEP_OPTIONS, DEFAULT_SLOT_STEP, "יש לבחור כל כמה זמן מתחיל תור."),
  cancel_notice_hours: fromList(CANCEL_NOTICE_OPTIONS, DEFAULT_CANCEL_NOTICE, "יש לבחור עד מתי אפשר לבטל."),
  is_active: checkbox,
});

export type BookingPageInput = z.infer<typeof bookingPageSchema>;

/**
 * The questions from the form: rows `question_<n>` (text) and `question_required_<n>` (checkbox), n = 0..9; an
 * empty row is skipped. Each keeps its id (`question_id_<n>`, stable across edits so answers stay matched) or gets a
 * new one. Returns an error message for the first bad row.
 */
export function questionsFromForm(formData: FormData, newId: () => string): { ok: true; questions: BookingQuestion[] } | { ok: false; message: string } {
  const questions: BookingQuestion[] = [];
  for (let n = 0; n < BOOKING_QUESTIONS_MAX; n++) {
    const label = String(formData.get(`question_${n}`) ?? "").trim();
    if (label === "") continue;
    if (label.length > BOOKING_QUESTION_MAX) {
      return { ok: false, message: `שאלה ארוכה מדי (עד ${BOOKING_QUESTION_MAX} תווים).` };
    }
    const sent = String(formData.get(`question_id_${n}`) ?? "");
    const id = /^[a-z0-9_-]{1,40}$/.test(sent) && !questions.some((q) => q.id === sent) ? sent : newId();
    questions.push({ id, label, required: formData.get(`question_required_${n}`) === "on" });
  }
  return { ok: true, questions };
}

/** A stored questions value as a list (anything else reads as none). */
export function readQuestions(value: unknown): BookingQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (q): q is BookingQuestion =>
      typeof q === "object" && q !== null && typeof (q as BookingQuestion).id === "string" && typeof (q as BookingQuestion).label === "string" && typeof (q as BookingQuestion).required === "boolean",
  );
}

/** The minimum notice as a short phrase for the list ("שעתיים לפני"). */
export function minNoticeText(minutes: number): string {
  return MIN_NOTICE_OPTIONS.find((o) => o.value === String(minutes))?.label ?? `${minutes} דקות לפני`;
}
