import { zoneTime } from "@/lib/format";

// SPD-05: "when should we call you back?" on the hosted form. The same list as
// app.intake_callback_at() / app.intake_callback_label() in migration
// callback_time (a unit test compares): slots of a few hours, today or tomorrow,
// in the business's time zone. The database checks the choice again and refuses
// a slot that has ended.

export const CALLBACK_INPUT = "callback";

export const CALLBACK_SLOTS = [
  { start: "09", end: "12" },
  { start: "12", end: "15" },
  { start: "15", end: "18" },
  { start: "18", end: "20" },
] as const;

export const CALLBACK_DAYS = [
  { key: "today", label: "היום" },
  { key: "tomorrow", label: "מחר" },
] as const;

export type CallbackOption = { value: string; label: string };
export type CallbackGroup = { label: string; options: CallbackOption[] };

/** The words for a choice, as the database writes them in the task and the notification. */
export function callbackLabel(value: string): string | null {
  if (value === "now") return "עכשיו";
  const match = /^(today|tomorrow)-(09|12|15|18)$/.exec(value);
  if (!match) return null;
  const day = CALLBACK_DAYS.find((d) => d.key === match[1]);
  const slot = CALLBACK_SLOTS.find((s) => s.start === match[2]);
  return day && slot ? `${day.label} בין ${slot.start}:00 ל-${slot.end}:00` : null;
}

const DEFAULT_ZONE = "Asia/Jerusalem";
// the shape app.intake_zone() lets through (as profiles_timezone_check)
const ZONE_SHAPE = /^(UTC|[A-Z][A-Za-z_]+(\/[A-Za-z0-9_+-]+){1,2})$/;

/** Wall-clock "HH:MM" in the zone; Jerusalem for a name Intl does not take. */
function safeZoneTime(now: Date, timeZone: string): string {
  if (ZONE_SHAPE.test(timeZone)) {
    try {
      return zoneTime(now, timeZone);
    } catch {
      // an unknown zone: fall through to the default
    }
  }
  return zoneTime(now, DEFAULT_ZONE);
}

/** The slots still open: today's that have not ended in the business's zone, and all of tomorrow's. */
export function callbackGroups(now: Date, timeZone: string): CallbackGroup[] {
  const time = safeZoneTime(now, timeZone);
  return CALLBACK_DAYS.map((day) => ({
    label: day.label,
    options: CALLBACK_SLOTS.filter((slot) => day.key !== "today" || time < `${slot.end}:00`).map((slot) => ({
      value: `${day.key}-${slot.start}`,
      label: `${slot.start}:00–${slot.end}:00`,
    })),
  })).filter((group) => group.options.length > 0);
}
