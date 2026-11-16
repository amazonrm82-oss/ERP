// USR-11 / owner (380) א: what the settings say when the summary's time falls inside the person's quiet hours. Mirrors
// app.digest_run_at (migration daily_digest) over app.quiet_hours_end (migration quiet_hours_answers), both on the business
// clock: a time inside the window [from, until) waits for the window's end when that end is on the same day; when the window
// containing the time ends on the next day (it began at or before the time and crosses midnight), the summary goes at the
// chosen time. Clock changes are left out: the form speaks of wall-clock times.

export type QuietHoursWindow = { from: string; until: string } | null;

export type QuietPlacement = "outside" | "held_until_end" | "sent_anyway";

const HH_MM = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

function minutes(value: string): number | null {
  const match = HH_MM.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** Where a time "HH:MM" stands against the quiet window: outside it, inside a part that ends today, or inside a part that ends tomorrow. */
export function timeInQuietHours(time: string, from: string | null | undefined, until: string | null | undefined): QuietPlacement {
  const t = minutes(time);
  const f = from ? minutes(from) : null;
  const u = until ? minutes(until) : null;
  if (t === null || f === null || u === null || f === u) return "outside";
  if (f < u) return t >= f && t < u ? "held_until_end" : "outside";
  // the window crosses midnight: from `from` to midnight ends tomorrow; from midnight to `until` ends today
  if (t >= f) return "sent_anyway";
  if (t < u) return "held_until_end";
  return "outside";
}

export const DIGEST_QUIET_SENT_ANYWAY = "השעה בתוך שעות השקט שלך; הסיכום יישלח בכל זאת";
export const DIGEST_QUIET_HELD = "הסיכום יישלח בסוף שעות השקט";

/** The note beside the time picker, or null when the time is outside the quiet hours (or they are off). */
export function digestQuietNote(time: string, quiet: QuietHoursWindow): string | null {
  if (!quiet) return null;
  const placement = timeInQuietHours(time, quiet.from, quiet.until);
  if (placement === "sent_anyway") return DIGEST_QUIET_SENT_ANYWAY;
  if (placement === "held_until_end") return `${DIGEST_QUIET_HELD} (${quiet.until})`;
  return null;
}
