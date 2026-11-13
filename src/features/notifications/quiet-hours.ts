// USR-11 (first part): quiet hours for notifications. Stored per user in
// public.notification_settings (quiet_from / quiet_until, both null = off) and
// applied by the database (app.apply_notification_settings, migration
// notification_quiet_hours): during the window the bell gets the notification at
// once and the phone push waits for the window's end, in the business's time zone.
// New leads, meeting reminders and system notices are never held, and saving
// quiet hours judges the waiting pushes again at once (migration quiet_hours_answers).
// This file only reads and checks the form; the window itself is never worked out here.

export type QuietHours = { from: string; until: string } | null;

export const QUIET_HOURS_HELP = "בשעות השקט ההתראות מופיעות בפעמון, וההתראה לטלפון נשלחת בסוף השעות. ליד חדש, תזכורת לפגישה והודעות מערכת נשלחים לטלפון מיד";

/** Defaults offered when the switch is turned on for the first time. */
export const QUIET_HOURS_DEFAULT = { from: "22:00", until: "07:00" } as const;

const TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])(?::[0-5][0-9])?$/;

/** "22:00:00" or "22:00" -> "22:00"; anything else -> null. */
export function quietTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = TIME.exec(value.trim());
  return match ? `${match[1]}:${match[2]}` : null;
}

/** The stored pair as the form shows it; a half-filled or broken pair reads as off. */
export function quietHoursFromRow(from: unknown, until: unknown): QuietHours {
  const f = quietTime(from);
  const u = quietTime(until);
  return f && u && f !== u ? { from: f, until: u } : null;
}

export type QuietHoursInput =
  | { ok: true; quiet: QuietHours }
  | { ok: false; field: "quiet_from" | "quiet_until"; message: string };

/** Reads the form's switch and two times. Off = null; on needs two different valid times. */
export function parseQuietHours(enabled: unknown, from: unknown, until: unknown): QuietHoursInput {
  if (enabled !== "on") return { ok: true, quiet: null };
  const f = quietTime(from);
  if (!f) return { ok: false, field: "quiet_from", message: "בחרו שעת התחלה לשעות השקט." };
  const u = quietTime(until);
  if (!u) return { ok: false, field: "quiet_until", message: "בחרו שעת סיום לשעות השקט." };
  if (f === u) return { ok: false, field: "quiet_until", message: "שעת הסיום צריכה להיות שונה משעת ההתחלה." };
  return { ok: true, quiet: { from: f, until: u } };
}

/** A short line under the times: "כל יום מ-22:00 עד 07:00 למחרת". */
export function quietHoursSummary(quiet: QuietHours): string {
  if (!quiet) return "שעות השקט כבויות.";
  const nextDay = quiet.from > quiet.until ? " למחרת" : "";
  return `כל יום מ-${quiet.from} עד ${quiet.until}${nextDay}, לפי השעון של כל עסק.`;
}

/** The line the form shows while the box is on: the summary, or what is still missing in the two times. */
export function quietHoursFormLine(from: unknown, until: unknown): string {
  const parsed = parseQuietHours("on", from, until);
  return parsed.ok ? quietHoursSummary(parsed.quiet) : parsed.message;
}
