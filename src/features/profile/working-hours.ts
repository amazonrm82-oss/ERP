// USR-01: a user's weekly working hours, stored in profiles.working_hours.
// Shape (owner's decision of 12 October 2026, split hours):
//   {"sun": [{"start": "08:00", "end": "12:00"}, {"start": "16:00", "end": "19:00"}], ...}
// Keys are weekdays, a missing day is a day off. Each day is a list of 1 to 3
// ranges, sorted, not overlapping (the end of one is at most the start of the
// next), times HH:MM (24 hours), start < end.
// The first version stored one object per day ({"sun": {"start", "end"}}).
// Rows of that shape still exist and stay valid: they are read as a list of one
// range and written back in the new shape the next time the user saves.
// Mirrors app.working_hours_ok() (migrations profile_fields and
// split_working_hours); keep the two in step. tests/working-hours-cases.ts is
// the shared table both test suites check. CAL-05 and CAP-09 read it later.

export const WEEKDAYS = [
  { key: "sun", label: "ראשון" },
  { key: "mon", label: "שני" },
  { key: "tue", label: "שלישי" },
  { key: "wed", label: "רביעי" },
  { key: "thu", label: "חמישי" },
  { key: "fri", label: "שישי" },
  { key: "sat", label: "שבת" },
] as const;

/** At most this many ranges in one day. */
export const MAX_DAY_RANGES = 3;

export type Weekday = (typeof WEEKDAYS)[number]["key"];
export type TimeRange = { start: string; end: string };
/** One working day: 1 to MAX_DAY_RANGES ranges, sorted, not overlapping. */
export type DayHours = TimeRange[];
/** Working hours as the app uses them (always the list shape). */
export type WorkingHours = Partial<Record<Weekday, DayHours>>;

const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DAY_KEYS: ReadonlySet<string> = new Set(WEEKDAYS.map((d) => d.key));

export function isTime(value: unknown): value is string {
  return typeof value === "string" && TIME.test(value);
}

/** {"start", "end"} and nothing else, both HH:MM, start before end. */
function isRange(value: unknown): value is TimeRange {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("start") || !keys.includes("end")) return false;
  const { start, end } = value as Record<string, unknown>;
  return isTime(start) && isTime(end) && start < end;
}

/** 1 to MAX_DAY_RANGES ranges, each one valid, sorted and not overlapping. */
function isDayList(value: unknown): value is DayHours {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DAY_RANGES) return false;
  for (let i = 0; i < value.length; i++) {
    if (!isRange(value[i])) return false;
    if (i > 0 && (value[i - 1] as TimeRange).end > (value[i] as TimeRange).start) return false;
  }
  return true;
}

/**
 * True when the value is a stored shape the database accepts (null means "not
 * set"): per day either a list of ranges or, from the first version, one range.
 */
export function isWorkingHours(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  for (const [day, hours] of Object.entries(value as Record<string, unknown>)) {
    if (!DAY_KEYS.has(day)) return false;
    if (!(Array.isArray(hours) ? isDayList(hours) : isRange(hours))) return false;
  }
  return true;
}

/**
 * The stored value as working hours in the list shape (a day of the first
 * version becomes a list of one range); anything malformed reads as "not set".
 */
export function readWorkingHours(value: unknown): WorkingHours | null {
  if (value === null || value === undefined || !isWorkingHours(value)) return null;
  const hours: WorkingHours = {};
  for (const { key } of WEEKDAYS) {
    const day = (value as Record<string, unknown>)[key];
    if (day === undefined) continue;
    hours[key] = (Array.isArray(day) ? day : [day]).map((r: TimeRange) => ({ start: r.start, end: r.end }));
  }
  return hours;
}

/** Sunday to Thursday, 09:00 to 17:00: what the form offers when nothing is set. */
export const DEFAULT_WORKING_HOURS: WorkingHours = {
  sun: [{ start: "09:00", end: "17:00" }],
  mon: [{ start: "09:00", end: "17:00" }],
  tue: [{ start: "09:00", end: "17:00" }],
  wed: [{ start: "09:00", end: "17:00" }],
  thu: [{ start: "09:00", end: "17:00" }],
};

function minutes(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

function clock(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The range the form adds after the given ones: from an hour after the last
 * end, two hours long, or what is left of the day. Empty times when the day is
 * already over (the user fills them in).
 */
export function nextRange(ranges: readonly TimeRange[]): TimeRange {
  const last = ranges.at(-1);
  if (!last || !isTime(last.end)) return { start: "16:00", end: "19:00" };
  if (minutes(last.end) >= 23 * 60) return { start: "", end: "" };
  const start = Math.min(minutes(last.end) + 60, 23 * 60);
  const end = Math.min(start + 120, 23 * 60 + 59);
  return { start: clock(start), end: clock(end) };
}

export type WorkingHoursResult = { ok: true; hours: WorkingHours } | { ok: false; day: Weekday; message: string };

/** Form field names of range `index` (from 0) of a day. */
export function rangeFieldNames(day: Weekday, index: number): { start: string; end: string } {
  return { start: `start_${day}_${index}`, end: `end_${day}_${index}` };
}

// how many range indexes the parser looks at; more than MAX_DAY_RANGES is refused
const SCAN_RANGES = 10;

/**
 * Working hours from the profile form: per day a checkbox `day_<key>` and per
 * range the fields `start_<key>_<i>`, `end_<key>_<i>` (i from 0). A day that is
 * not ticked is a day off. The ranges are sorted by start time before they are
 * checked for overlap, so the order they were typed in does not matter.
 * A form of the first version (`start_<key>`, `end_<key>`) still parses.
 */
export function parseWorkingHours(formData: FormData): WorkingHoursResult {
  const hours: WorkingHours = {};
  for (const { key, label } of WEEKDAYS) {
    if (formData.get(`day_${key}`) !== "on") continue;
    const raw: { start: FormDataEntryValue | null; end: FormDataEntryValue | null }[] = [];
    for (let i = 0; i < SCAN_RANGES; i++) {
      const names = rangeFieldNames(key, i);
      const start = formData.get(names.start);
      const end = formData.get(names.end);
      if (start === null && end === null) continue;
      raw.push({ start, end });
    }
    if (raw.length === 0) raw.push({ start: formData.get(`start_${key}`), end: formData.get(`end_${key}`) });
    if (raw.length > MAX_DAY_RANGES) {
      return { ok: false, day: key, message: `ביום ${label} אפשר עד ${MAX_DAY_RANGES} טווחי שעות.` };
    }
    const where = (i: number) => (raw.length > 1 ? `ביום ${label}, בטווח ${i + 1},` : `ביום ${label}`);
    const ranges: TimeRange[] = [];
    for (const [i, { start, end }] of raw.entries()) {
      if (!isTime(start) || !isTime(end)) {
        return { ok: false, day: key, message: `${where(i)} יש להזין שעת התחלה ושעת סיום.` };
      }
      if (start >= end) {
        return { ok: false, day: key, message: `${where(i)} שעת הסיום צריכה להיות אחרי שעת ההתחלה.` };
      }
      ranges.push({ start, end });
    }
    ranges.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i - 1].end > ranges[i].start) {
        // no times in the text: a time range inside Hebrew text flips around its dash
        return { ok: false, day: key, message: `ביום ${label} יש טווחים חופפים. כל טווח צריך להתחיל אחרי שהקודם נגמר.` };
      }
    }
    hours[key] = ranges;
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
