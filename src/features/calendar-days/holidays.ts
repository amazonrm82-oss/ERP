/**
 * Israeli holidays and observances (CAL-03), and the organization's rest days.
 *
 * Pure code, no dependency. The Hebrew date of each day is computed here with
 * the fixed arithmetic of the Hebrew calendar (the molad of Tishrei and the
 * four postponements), so every browser and the server give the same answer.
 * The platform's own Hebrew calendar (Intl, ICU) was the first choice, but ICU
 * 77 gets the year 5807 wrong (Rosh Hashana on 2 Oct 2046 instead of 1 Oct, a
 * 385-day year that starts on a Tuesday, which the calendar does not allow);
 * the unit tests compare the two day by day for 2000-2044.
 * The rules below say which Hebrew dates are holidays in Israel, including the
 * official moves of the national days when they fall next to Shabbat.
 *
 * Days are "YYYY-MM-DD" strings, read as calendar days (no time zone), like
 * src/lib/calendar-grid.ts. The Hebrew date given for a day is the one that is
 * current during its daytime; a holiday "starts the evening before", which is
 * what the erev day is for.
 */

import { addDays, weekday } from "@/lib/calendar-grid";
import { isCalendarDate } from "@/lib/calendar-date";

/**
 * rest = a day off by law; erev = the day before a main holiday (work usually ends early);
 * short = a shortened working day of its own, outside the eves rule (Yom HaZikaron); observance = marked, a work day.
 */
export type HolidayKind = "rest" | "erev" | "short" | "observance";

export type Holiday = {
  date: string;
  /** which occasion of OCCASIONS it is (a business may choose it as a rest day) */
  key: OccasionKey;
  /** Hebrew, short enough for a day cell */
  name: string;
  kind: HolidayKind;
  /** a day of mourning or remembrance (HEB-02 holds marketing messages on these) */
  memorial?: boolean;
};

/** 0 = Sunday … 6 = Saturday, as in calendar-grid. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type CalendarSettings = {
  /** the weekly days the business does not work */
  restWeekdays: Weekday[];
  /** holidays that are rest days by law (Rosh Hashana, Pesach, Yom HaAtzmaut …) are days off */
  holidaysRest: boolean;
  /** the erev days of the main holidays are days off too */
  holidayEvesRest: boolean;
  /** more occasions the business does not work on, one by one (chol hamoed, Mimouna, Purim …); none by default */
  restOccasions: OccasionKey[];
};

/** Friday and Saturday off, holidays off, erev days are work days, no other occasion off. */
export const DEFAULT_CALENDAR_SETTINGS: CalendarSettings = {
  restWeekdays: [5, 6],
  holidaysRest: true,
  holidayEvesRest: false,
  restOccasions: [],
};

/**
 * Every occasion the calendar marks, in the order of the year from Tishrei,
 * with the kind it is marked as. The key is stored in
 * org_calendar_settings.rest_occasions when a business chooses the occasion as
 * a rest day of its own, so a key never changes once released.
 * Yom HaZikaron is a shortened working day of its own (kind "short"), not an
 * eve: the "eves are rest days" switch does not close it, a business closes it
 * by choosing it in the list like any other occasion; it stays a memorial day
 * (owner's answer, 12 October 2026).
 */
export const OCCASIONS = [
  { key: "rosh_hashana", name: "ראש השנה", kind: "rest" },
  { key: "yom_kippur_eve", name: "ערב יום כיפור", kind: "erev" },
  { key: "yom_kippur", name: "יום כיפור", kind: "rest" },
  { key: "sukkot_eve", name: "ערב סוכות", kind: "erev" },
  { key: "sukkot", name: "סוכות", kind: "rest" },
  { key: "chol_hamoed_sukkot", name: "חול המועד סוכות", kind: "observance" },
  { key: "hoshana_raba", name: "הושענא רבה", kind: "erev" },
  { key: "simchat_torah", name: "שמחת תורה", kind: "rest" },
  { key: "chanukah", name: "חנוכה", kind: "observance" },
  { key: "tu_bishvat", name: "ט״ו בשבט", kind: "observance" },
  { key: "purim", name: "פורים", kind: "observance" },
  { key: "shushan_purim", name: "שושן פורים (בירושלים)", kind: "observance" },
  { key: "pesach_eve", name: "ערב פסח", kind: "erev" },
  { key: "pesach", name: "פסח", kind: "rest" },
  { key: "chol_hamoed_pesach", name: "חול המועד פסח", kind: "observance" },
  { key: "pesach_7_eve", name: "ערב שביעי של פסח", kind: "erev" },
  { key: "pesach_7", name: "שביעי של פסח", kind: "rest" },
  { key: "mimouna", name: "מימונה", kind: "observance" },
  { key: "yom_hashoah", name: "יום השואה", kind: "observance" },
  { key: "yom_hazikaron", name: "יום הזיכרון", kind: "short" },
  { key: "yom_haatzmaut", name: "יום העצמאות", kind: "rest" },
  { key: "lag_baomer", name: "ל״ג בעומר", kind: "observance" },
  { key: "yom_yerushalayim", name: "יום ירושלים", kind: "observance" },
  { key: "shavuot_eve", name: "ערב שבועות", kind: "erev" },
  { key: "shavuot", name: "שבועות", kind: "rest" },
  { key: "tisha_bav", name: "תשעה באב", kind: "observance" },
  { key: "rosh_hashana_eve", name: "ערב ראש השנה", kind: "erev" },
] as const satisfies readonly { key: string; name: string; kind: HolidayKind }[];

export type OccasionKey = (typeof OCCASIONS)[number]["key"];

export const OCCASION_KEYS = OCCASIONS.map((occasion) => occasion.key) as [OccasionKey, ...OccasionKey[]];

export function isOccasionKey(value: unknown): value is OccasionKey {
  return typeof value === "string" && (OCCASION_KEYS as readonly string[]).includes(value);
}

/** The longest range one call computes: a year view and its edges, with room to spare. */
export const MAX_RANGE_DAYS = 800;

// ---------------------------------------------------------------------------
// Hebrew dates
// ---------------------------------------------------------------------------

/**
 * Months in the order of the year, from Tishrei. A common year's Adar is 7,
 * like a leap year's Adar II: Purim is in it either way. Adar I is 6.
 */
export const HEBREW_MONTHS = [
  "",
  "תשרי",
  "חשוון",
  "כסלו",
  "טבת",
  "שבט",
  "אדר א׳",
  "אדר",
  "ניסן",
  "אייר",
  "סיוון",
  "תמוז",
  "אב",
  "אלול",
] as const;

const TISHREI = 1;
const KISLEV = 3;
const TEVET = 4;
const SHEVAT = 5;
const ADAR = 7;
const NISAN = 8;
const IYAR = 9;
const SIVAN = 10;
const AV = 12;
const ELUL = 13;

export type HebrewDate = { year: number; month: number; day: number; leap: boolean };

/** A leap year has 13 months (Adar I and Adar II). */
export function isLeapYear(year: number): boolean {
  return (7 * year + 1) % 19 < 7;
}

// Days from the epoch to the molad of Tishrei, after the rule that moves Rosh
// Hashana off Sunday, Wednesday and Friday. The 12084 parts are the molad of
// year 1 (BaHaRaD) plus six hours, which applies "molad zaken" through the floor.
function elapsedDays(year: number): number {
  const months = Math.floor((235 * year - 234) / 19);
  const parts = 12084 + 13753 * months;
  const days = 29 * months + Math.floor(parts / 25920);
  return (3 * (days + 1)) % 7 < 3 ? days + 1 : days;
}

// The other two postponements (GaTaRaD, BeTUTaKPaT): no year may be 356 or 382 days long.
function yearDelay(year: number): number {
  const [before, now, after] = [elapsedDays(year - 1), elapsedDays(year), elapsedDays(year + 1)];
  if (after - now === 356) return 2;
  if (now - before === 382) return 1;
  return 0;
}

// Day numbers count from 1 January of year 1 (= 1); 1 January 1970 is 719163.
const HEBREW_EPOCH = -1373427;
const UNIX_EPOCH_DAY = 719163;

/** Day number of 1 Tishrei of a Hebrew year. */
function newYear(year: number): number {
  return HEBREW_EPOCH + elapsedDays(year) + yearDelay(year);
}

/** Months of a year in order, with their lengths (Adar I is 0 days long in a common year). */
function monthLengths(year: number): number[] {
  const length = newYear(year + 1) - newYear(year);
  // a "complete" year has a 30-day Cheshvan, a "deficient" one a 29-day Kislev
  const cheshvan = length % 10 === 5 ? 30 : 29;
  const kislev = length % 10 === 3 ? 29 : 30;
  return [0, 30, cheshvan, kislev, 29, 30, isLeapYear(year) ? 30 : 0, 29, 30, 29, 30, 29, 30, 29];
}

const hebrewCache = new Map<string, HebrewDate | null>();

/** The Hebrew date during the daytime of a calendar day, or null for a bad day. */
export function hebrewDate(day: string): HebrewDate | null {
  const cached = hebrewCache.get(day);
  if (cached !== undefined) return cached;
  let result: HebrewDate | null = null;
  if (isCalendarDate(day)) {
    const fixed = Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000) + UNIX_EPOCH_DAY;
    let year = Math.floor((fixed - HEBREW_EPOCH) / 365.25) + 1;
    while (newYear(year) > fixed) year--;
    while (newYear(year + 1) <= fixed) year++;
    let rest = fixed - newYear(year);
    const lengths = monthLengths(year);
    let month = 1;
    while (rest >= lengths[month]) {
      rest -= lengths[month];
      month++;
    }
    result = { year, month, day: rest + 1, leap: isLeapYear(year) };
  }
  if (hebrewCache.size > 4000) hebrewCache.clear();
  hebrewCache.set(day, result);
  return result;
}

const UNITS = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט"];
const TENS = ["", "י", "כ", "ל"];

/** 1 to 30 in Hebrew letters: "א׳", "ט״ו", "כ״ז". */
export function hebrewNumeral(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 30) return String(n);
  let letters = n === 15 ? "טו" : n === 16 ? "טז" : `${TENS[Math.floor(n / 10)]}${UNITS[n % 10]}`;
  letters = letters || String(n);
  return letters.length === 1 ? `${letters}׳` : `${letters.slice(0, -1)}״${letters.slice(-1)}`;
}

/** "ט״ו בתשרי" for a day cell; "" for a malformed date. */
export function hebrewDayLabel(day: string): string {
  const date = hebrewDate(day);
  if (!date) return "";
  const month = date.month === ADAR && date.leap ? "אדר ב׳" : HEBREW_MONTHS[date.month];
  return `${hebrewNumeral(date.day)} ב${month}`;
}

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

/** The holidays of one day: none or one (a list, so a future rule may add a second). */
export function holidaysOn(day: string): Holiday[] {
  if (!isCalendarDate(day)) return [];
  const date = hebrewDate(day);
  if (!date) return [];
  const w = weekday(day);
  const found: Holiday[] = [];
  const add = (key: OccasionKey, name: string, kind: HolidayKind, memorial = false) =>
    found.push(memorial ? { date: day, key, name, kind, memorial } : { date: day, key, name, kind });
  const { month, day: d } = date;

  switch (month) {
    case TISHREI:
      if (d === 1 || d === 2) add("rosh_hashana", "ראש השנה", "rest");
      else if (d === 9) add("yom_kippur_eve", "ערב יום כיפור", "erev");
      else if (d === 10) add("yom_kippur", "יום כיפור", "rest");
      else if (d === 14) add("sukkot_eve", "ערב סוכות", "erev");
      else if (d === 15) add("sukkot", "סוכות", "rest");
      else if (d >= 16 && d <= 20) add("chol_hamoed_sukkot", "חול המועד סוכות", "observance");
      // the eve of Shemini Atzeret
      else if (d === 21) add("hoshana_raba", "הושענא רבה", "erev");
      // in Israel one day: Shemini Atzeret and Simchat Torah together
      else if (d === 22) add("simchat_torah", "שמחת תורה", "rest");
      break;
    case KISLEV:
      if (d >= 25) add("chanukah", "חנוכה", "observance");
      break;
    case TEVET: {
      // eight days from 25 Kislev: to 2 Tevet after a 30-day Kislev, to 3 Tevet after a 29-day one
      const kislevLength = hebrewDate(addDays(day, -d))?.day ?? 30;
      if (kislevLength - 24 + d <= 8) add("chanukah", "חנוכה", "observance");
      break;
    }
    case SHEVAT:
      if (d === 15) add("tu_bishvat", "ט״ו בשבט", "observance");
      break;
    case ADAR:
      if (d === 14) add("purim", "פורים", "observance");
      else if (d === 15) add("shushan_purim", "שושן פורים (בירושלים)", "observance");
      break;
    case NISAN:
      if (d === 14) add("pesach_eve", "ערב פסח", "erev");
      else if (d === 15) add("pesach", "פסח", "rest");
      else if (d >= 16 && d <= 19) add("chol_hamoed_pesach", "חול המועד פסח", "observance");
      else if (d === 20) add("pesach_7_eve", "ערב שביעי של פסח", "erev");
      else if (d === 21) add("pesach_7", "שביעי של פסח", "rest");
      // the day after Pesach; when that is Shabbat (Pesach ended on Friday) it moves to Sunday
      else if ((d === 22 && w !== 6) || (d === 23 && w === 0)) add("mimouna", "מימונה", "observance");
      // 27 Nisan; moved to Thursday when it falls on Friday, to Monday when on Sunday
      if ((d === 27 && w !== 5 && w !== 0) || (d === 26 && w === 4) || (d === 28 && w === 1)) {
        add("yom_hashoah", "יום השואה", "observance", true);
      }
      break;
    case IYAR:
      // Yom HaAtzmaut is 5 Iyar, moved back to Thursday when 5 Iyar is a Friday
      // or Shabbat, and to Tuesday when it is a Monday (so the memorial day
      // before it does not touch Shabbat). Yom HaZikaron is the day before:
      // a shortened working day (not an eve) and a memorial day.
      if ((d === 5 && w === 3) || (d === 4 && w === 4) || (d === 3 && w === 4) || (d === 6 && w === 2)) {
        add("yom_haatzmaut", "יום העצמאות", "rest");
      }
      if ((d === 4 && w === 2) || (d === 3 && w === 3) || (d === 2 && w === 3) || (d === 5 && w === 1)) {
        add("yom_hazikaron", "יום הזיכרון", "short", true);
      }
      if (d === 18) add("lag_baomer", "ל״ג בעומר", "observance");
      if (d === 28) add("yom_yerushalayim", "יום ירושלים", "observance");
      break;
    case SIVAN:
      if (d === 5) add("shavuot_eve", "ערב שבועות", "erev");
      else if (d === 6) add("shavuot", "שבועות", "rest");
      break;
    case AV:
      // a fast is not held on Shabbat: then it is on Sunday, 10 Av
      if (d === 9 && w !== 6) add("tisha_bav", "תשעה באב", "observance", true);
      else if (d === 10 && w === 0) add("tisha_bav", "תשעה באב (נדחה)", "observance", true);
      break;
    case ELUL:
      if (d === 29) add("rosh_hashana_eve", "ערב ראש השנה", "erev");
      break;
  }
  return found;
}

/** Every holiday from `from` to `to`, both included, in date order. Empty for a bad range; a longer range than MAX_RANGE_DAYS is cut there. */
export function holidaysInRange(from: string, to: string): Holiday[] {
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) return [];
  const result: Holiday[] = [];
  let day = from;
  for (let i = 0; i < MAX_RANGE_DAYS && day <= to; i++) {
    result.push(...holidaysOn(day));
    day = addDays(day, 1);
  }
  return result;
}

/** The same holidays keyed by day, for a calendar grid. */
export function holidaysByDay(from: string, to: string): Map<string, Holiday[]> {
  const map = new Map<string, Holiday[]>();
  for (const holiday of holidaysInRange(from, to)) {
    const list = map.get(holiday.date);
    if (list) list.push(holiday);
    else map.set(holiday.date, [holiday]);
  }
  return map;
}

export type HolidaySpan = { from: string; to: string; key: OccasionKey; name: string; kind: HolidayKind; memorial?: boolean };

/** Runs of the same holiday on consecutive days (Rosh Hashana, chol hamoed, Chanukah) as one entry, for a list. */
export function holidaySpans(holidays: Holiday[]): HolidaySpan[] {
  const spans: HolidaySpan[] = [];
  for (const holiday of holidays) {
    const last = spans.at(-1);
    if (last && last.name === holiday.name && addDays(last.to, 1) === holiday.date) {
      last.to = holiday.date;
    } else {
      spans.push({
        from: holiday.date,
        to: holiday.date,
        key: holiday.key,
        name: holiday.name,
        kind: holiday.kind,
        ...(holiday.memorial ? { memorial: true } : {}),
      });
    }
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Rest days
// ---------------------------------------------------------------------------

/** The weekly rest days, cleaned: whole numbers 0–6, no repeats, in order. A business works at least one day. */
export function restDays(settings: Pick<CalendarSettings, "restWeekdays">): Weekday[] {
  const days = [...new Set(settings.restWeekdays)]
    .filter((n): n is Weekday => Number.isInteger(n) && n >= 0 && n <= 6)
    .sort((a, b) => a - b);
  return days.length === 7 ? DEFAULT_CALENDAR_SETTINGS.restWeekdays : days;
}

/** The occasions chosen as rest days, cleaned: known keys only, no repeats, in the order of OCCASIONS. */
export function restOccasions(values: readonly unknown[] | null | undefined): OccasionKey[] {
  const chosen = new Set((values ?? []).filter(isOccasionKey));
  return OCCASION_KEYS.filter((key) => chosen.has(key));
}

/** Is an occasion a day off for the business: by its kind (holidays, eves) or chosen one by one. A shortened day closes only when chosen. */
export function occasionClosed(occasion: Pick<Holiday, "key" | "kind">, settings: CalendarSettings): boolean {
  return (
    (occasion.kind === "rest" && settings.holidaysRest) ||
    (occasion.kind === "erev" && settings.holidayEvesRest) ||
    settings.restOccasions.includes(occasion.key)
  );
}

/** A row of org_calendar_settings (or none) as settings; unknown values are dropped, a missing row is the defaults. */
export function calendarSettingsFromRow(
  row: { rest_weekdays: number[]; holidays_rest: boolean; holiday_eves_rest: boolean; rest_occasions?: string[] | null } | null,
): CalendarSettings {
  if (!row) return DEFAULT_CALENDAR_SETTINGS;
  return {
    restWeekdays: restDays({ restWeekdays: row.rest_weekdays as Weekday[] }),
    holidaysRest: row.holidays_rest,
    holidayEvesRest: row.holiday_eves_rest,
    restOccasions: restOccasions(row.rest_occasions),
  };
}

export type RestReason = { kind: "weekly" } | { kind: "holiday"; holiday: Holiday };

/** Why the business does not work on a day, or null when it does. */
export function restReason(day: string, settings: CalendarSettings = DEFAULT_CALENDAR_SETTINGS): RestReason | null {
  if (!isCalendarDate(day)) return null;
  for (const holiday of holidaysOn(day)) {
    if (occasionClosed(holiday, settings)) {
      return { kind: "holiday", holiday };
    }
  }
  return restDays(settings).includes(weekday(day) as Weekday) ? { kind: "weekly" } : null;
}

export function isRestDay(day: string, settings: CalendarSettings = DEFAULT_CALENDAR_SETTINGS): boolean {
  return restReason(day, settings) !== null;
}

/** Hebrew labels of the kinds, for a legend and for screen readers. */
export const HOLIDAY_KIND_LABELS: Record<HolidayKind, string> = {
  rest: "חג",
  erev: "ערב חג",
  short: "יום עבודה מקוצר",
  observance: "מועד",
};
