// USR-01: a user's weekly working hours, stored in profiles.working_hours.
// Shape: {"sun": {"start": "09:00", "end": "17:00"}, ...}. Keys are weekdays,
// a missing day is a day off, times are HH:MM (24 hours) and start < end.
// Mirrors app.working_hours_ok() in migration profile_fields; keep the two in
// step (tests/db/53-profile-fields.test.ts compares them). CAL-05 and CAP-09
// read it later.

export const WEEKDAYS = [
  { key: "sun", label: "ראשון" },
  { key: "mon", label: "שני" },
  { key: "tue", label: "שלישי" },
  { key: "wed", label: "רביעי" },
  { key: "thu", label: "חמישי" },
  { key: "fri", label: "שישי" },
  { key: "sat", label: "שבת" },
] as const;

export type Weekday = (typeof WEEKDAYS)[number]["key"];
export type DayHours = { start: string; end: string };
export type WorkingHours = Partial<Record<Weekday, DayHours>>;

const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DAY_KEYS: ReadonlySet<string> = new Set(WEEKDAYS.map((d) => d.key));

export function isTime(value: unknown): value is string {
  return typeof value === "string" && TIME.test(value);
}

/** True when the value has exactly the stored shape (null means "not set"). */
export function isWorkingHours(value: unknown): value is WorkingHours | null {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  for (const [day, range] of Object.entries(value as Record<string, unknown>)) {
    if (!DAY_KEYS.has(day)) return false;
    if (typeof range !== "object" || range === null || Array.isArray(range)) return false;
    const keys = Object.keys(range);
    if (keys.length !== 2 || !keys.includes("start") || !keys.includes("end")) return false;
    const { start, end } = range as Record<string, unknown>;
    if (!isTime(start) || !isTime(end) || start >= end) return false;
  }
  return true;
}

/** The stored value as working hours; anything malformed reads as "not set". */
export function readWorkingHours(value: unknown): WorkingHours | null {
  return value !== null && value !== undefined && isWorkingHours(value) ? value : null;
}

/** Sunday to Thursday, 09:00 to 17:00: what the form offers when nothing is set. */
export const DEFAULT_WORKING_HOURS: WorkingHours = {
  sun: { start: "09:00", end: "17:00" },
  mon: { start: "09:00", end: "17:00" },
  tue: { start: "09:00", end: "17:00" },
  wed: { start: "09:00", end: "17:00" },
  thu: { start: "09:00", end: "17:00" },
};

export type WorkingHoursResult = { ok: true; hours: WorkingHours } | { ok: false; day: Weekday; message: string };

/**
 * Working hours from the profile form: per day a checkbox `day_<key>` and the
 * fields `start_<key>`, `end_<key>`. A day that is not ticked is a day off.
 */
export function parseWorkingHours(formData: FormData): WorkingHoursResult {
  const hours: WorkingHours = {};
  for (const { key, label } of WEEKDAYS) {
    if (formData.get(`day_${key}`) !== "on") continue;
    const start = formData.get(`start_${key}`);
    const end = formData.get(`end_${key}`);
    if (!isTime(start) || !isTime(end)) {
      return { ok: false, day: key, message: `ביום ${label} יש להזין שעת התחלה ושעת סיום.` };
    }
    if (start >= end) {
      return { ok: false, day: key, message: `ביום ${label} שעת הסיום צריכה להיות אחרי שעת ההתחלה.` };
    }
    hours[key] = { start, end };
  }
  return { ok: true, hours };
}

let zones: ReadonlySet<string> | null = null;

/** IANA time zones this runtime knows (Intl), plus UTC. */
export function timeZones(): ReadonlySet<string> {
  if (!zones) {
    const list = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
    zones = new Set([...list, "UTC"]);
  }
  return zones;
}

/** True for an IANA time zone name the runtime knows ("Asia/Jerusalem"). */
export function isTimeZone(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && timeZones().has(value);
}
