import { describe, expect, it } from "vitest";

import {
  calendarSettingsFromRow,
  DEFAULT_CALENDAR_SETTINGS,
  hebrewDate,
  hebrewDayLabel,
  hebrewNumeral,
  HOLIDAY_KIND_LABELS,
  holidaysByDay,
  holidaysInRange,
  holidaysOn,
  holidaySpans,
  isRestDay,
  MAX_RANGE_DAYS,
  OCCASION_KEYS,
  OCCASIONS,
  occasionClosed,
  restDays,
  restOccasions,
  restReason,
  type CalendarSettings,
} from "@/features/calendar-days/holidays";
import { calendarSettingsFromForm, calendarSettingsSchema } from "@/features/calendar-days/schema";
import { addDays } from "@/lib/calendar-grid";

/** "name:kind" of every holiday on a day, for short expectations. */
const on = (day: string) => holidaysOn(day).map((h) => `${h.name}:${h.kind}`);
/** The days in a year that carry a holiday of this name. */
const daysOf = (name: string, year: number) =>
  holidaysInRange(`${year}-01-01`, `${year}-12-31`)
    .filter((h) => h.name === name)
    .map((h) => h.date);

// Every expected date below was checked against the published Israeli
// calendar of that year (Rosh Hashana 5787 = 12-13 Sep 2026, and so on).
describe("Israeli holidays 2026-2028 (CAL-03)", () => {
  const cases: [string, string, string[]][] = [
    // 5786 / 2026
    ["2026", "ט״ו בשבט", ["2026-02-02"]],
    ["2026", "פורים", ["2026-03-03"]],
    ["2026", "שושן פורים (בירושלים)", ["2026-03-04"]],
    ["2026", "ערב פסח", ["2026-04-01"]],
    ["2026", "פסח", ["2026-04-02"]],
    ["2026", "חול המועד פסח", ["2026-04-03", "2026-04-04", "2026-04-05", "2026-04-06"]],
    ["2026", "ערב שביעי של פסח", ["2026-04-07"]],
    ["2026", "שביעי של פסח", ["2026-04-08"]],
    ["2026", "יום השואה", ["2026-04-14"]],
    // 5 Iyar 5786 is a Wednesday: no move
    ["2026", "יום הזיכרון", ["2026-04-21"]],
    ["2026", "יום העצמאות", ["2026-04-22"]],
    ["2026", "ל״ג בעומר", ["2026-05-05"]],
    ["2026", "יום ירושלים", ["2026-05-15"]],
    ["2026", "ערב שבועות", ["2026-05-21"]],
    ["2026", "שבועות", ["2026-05-22"]],
    ["2026", "תשעה באב", ["2026-07-23"]],
    ["2026", "ערב ראש השנה", ["2026-09-11"]],
    ["2026", "ראש השנה", ["2026-09-12", "2026-09-13"]],
    ["2026", "ערב יום כיפור", ["2026-09-20"]],
    ["2026", "יום כיפור", ["2026-09-21"]],
    ["2026", "ערב סוכות", ["2026-09-25"]],
    ["2026", "סוכות", ["2026-09-26"]],
    ["2026", "חול המועד סוכות", ["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"]],
    ["2026", "הושענא רבה", ["2026-10-02"]],
    ["2026", "שמחת תורה", ["2026-10-03"]],
    // Chanukah 5786 (14-22 Dec 2025 evening) ends in 2025; 5787 is 5-12 Dec 2026
    ["2026", "חנוכה", ["2026-12-05", "2026-12-06", "2026-12-07", "2026-12-08", "2026-12-09", "2026-12-10", "2026-12-11", "2026-12-12"]],

    // 5787 (a leap year) / 2027
    ["2027", "ט״ו בשבט", ["2027-01-23"]],
    // in Adar II, not Adar I
    ["2027", "פורים", ["2027-03-23"]],
    ["2027", "שושן פורים (בירושלים)", ["2027-03-24"]],
    ["2027", "פסח", ["2027-04-22"]],
    ["2027", "שביעי של פסח", ["2027-04-28"]],
    ["2027", "יום השואה", ["2027-05-04"]],
    ["2027", "יום הזיכרון", ["2027-05-11"]],
    ["2027", "יום העצמאות", ["2027-05-12"]],
    ["2027", "ל״ג בעומר", ["2027-05-25"]],
    ["2027", "יום ירושלים", ["2027-06-04"]],
    ["2027", "שבועות", ["2027-06-11"]],
    ["2027", "תשעה באב", ["2027-08-12"]],
    ["2027", "ראש השנה", ["2027-10-02", "2027-10-03"]],
    ["2027", "יום כיפור", ["2027-10-11"]],
    ["2027", "סוכות", ["2027-10-16"]],
    ["2027", "שמחת תורה", ["2027-10-23"]],
    // Chanukah 5788 runs into the new year: 25 Dec 2027 - 1 Jan 2028
    ["2027", "חנוכה", ["2027-12-25", "2027-12-26", "2027-12-27", "2027-12-28", "2027-12-29", "2027-12-30", "2027-12-31"]],

    // 5788 / 2028
    ["2028", "חנוכה", ["2028-01-01", "2028-12-13", "2028-12-14", "2028-12-15", "2028-12-16", "2028-12-17", "2028-12-18", "2028-12-19", "2028-12-20"]],
    ["2028", "ט״ו בשבט", ["2028-02-12"]],
    ["2028", "פורים", ["2028-03-12"]],
    ["2028", "פסח", ["2028-04-11"]],
    ["2028", "שביעי של פסח", ["2028-04-17"]],
    // 27 Nisan 5788 is a Sunday: moved to Monday
    ["2028", "יום השואה", ["2028-04-24"]],
    // 5 Iyar 5788 is a Monday: Yom HaAtzmaut moves to Tuesday, Yom HaZikaron stays on Monday
    ["2028", "יום הזיכרון", ["2028-05-01"]],
    ["2028", "יום העצמאות", ["2028-05-02"]],
    ["2028", "ל״ג בעומר", ["2028-05-14"]],
    ["2028", "יום ירושלים", ["2028-05-24"]],
    ["2028", "שבועות", ["2028-05-31"]],
    ["2028", "תשעה באב", ["2028-08-01"]],
    ["2028", "ערב ראש השנה", ["2028-09-20"]],
    ["2028", "ראש השנה", ["2028-09-21", "2028-09-22"]],
    ["2028", "יום כיפור", ["2028-09-30"]],
    ["2028", "סוכות", ["2028-10-05"]],
    ["2028", "שמחת תורה", ["2028-10-12"]],
  ];

  it.each(cases)("%s: %s", (year, name, expected) => {
    expect(daysOf(name, Number(year))).toEqual(expected);
  });

  it("marks each day with the right kind", () => {
    expect(on("2026-09-11")).toEqual(["ערב ראש השנה:erev"]);
    expect(on("2026-09-12")).toEqual(["ראש השנה:rest"]);
    expect(on("2026-09-21")).toEqual(["יום כיפור:rest"]);
    expect(on("2026-10-03")).toEqual(["שמחת תורה:rest"]);
    expect(on("2026-04-22")).toEqual(["יום העצמאות:rest"]);
    // Yom HaZikaron is a shortened working day of its own, not an eve (owner's answer, 12 October 2026)
    expect(on("2026-04-21")).toEqual(["יום הזיכרון:short"]);
    expect(on("2026-03-03")).toEqual(["פורים:observance"]);
    expect(on("2026-12-05")).toEqual(["חנוכה:observance"]);
    expect(on("2026-10-14")).toEqual([]);
  });

  it("marks the days of remembrance", () => {
    const memorial = holidaysInRange("2026-01-01", "2026-12-31").filter((h) => h.memorial).map((h) => h.name);
    expect(memorial).toEqual(["יום השואה", "יום הזיכרון", "תשעה באב"]);
    // a shortened working day that keeps its memorial mark
    expect(holidaysOn("2026-04-21")).toEqual([{ date: "2026-04-21", key: "yom_hazikaron", name: "יום הזיכרון", kind: "short", memorial: true }]);
  });

  it("Mimouna is the day after Pesach, moved to Sunday when that is Shabbat", () => {
    expect(daysOf("מימונה", 2026)).toEqual(["2026-04-09"]);
    expect(daysOf("מימונה", 2025)).toEqual(["2025-04-20"]);
    // 2018: Pesach ended on Friday 6 April, so not on Shabbat 7 April but on Sunday 8 April
    expect(daysOf("מימונה", 2018)).toEqual(["2018-04-08"]);
    expect(on("2026-04-09")).toEqual(["מימונה:observance"]);
  });

  it("Sukkot in Israel: one holy day, five days of chol hamoed, one day of Shemini Atzeret", () => {
    const sukkot = holidaysInRange("2026-09-25", "2026-10-04").map((h) => `${h.date} ${h.kind}`);
    expect(sukkot).toEqual([
      "2026-09-25 erev",
      "2026-09-26 rest",
      "2026-09-27 observance",
      "2026-09-28 observance",
      "2026-09-29 observance",
      "2026-09-30 observance",
      "2026-10-01 observance",
      "2026-10-02 erev",
      "2026-10-03 rest",
    ]);
  });

  it("Pesach in Israel: seven days, the first and the seventh are rest days", () => {
    const pesach = holidaysInRange("2027-04-21", "2027-04-28").map((h) => h.kind);
    expect(pesach).toEqual(["erev", "rest", "observance", "observance", "observance", "observance", "erev", "rest"]);
  });
});

describe("the list of occasions", () => {
  it("has one entry per key, and every day's holiday is in it with the same kind and name", () => {
    expect(new Set(OCCASION_KEYS).size).toBe(OCCASIONS.length);
    const byKey = new Map(OCCASIONS.map((o) => [o.key as string, o]));
    for (const holiday of holidaysInRange("2025-09-01", "2027-09-30")) {
      const occasion = byKey.get(holiday.key);
      expect(occasion, holiday.key).toBeDefined();
      expect(holiday.kind, holiday.key).toBe(occasion?.kind);
      // the moved Tisha B'Av keeps its key with "(נדחה)" in its name
      expect(holiday.name.startsWith(occasion?.name ?? "?"), holiday.key).toBe(true);
    }
  });

  it("every occasion comes every year", () => {
    for (const year of [2026, 2027, 2028, 2030, 2041]) {
      // Rosh Hashana of one year to the eve of the next
      const keys = new Set(holidaysInRange(`${year}-09-01`, `${year + 1}-09-01`).map((h) => h.key));
      expect([...OCCASION_KEYS].filter((key) => !keys.has(key)), String(year)).toEqual([]);
    }
  });
});

describe("the official moves of the national days", () => {
  it("5 Iyar on Friday: Yom HaAtzmaut on Thursday, Yom HaZikaron on Wednesday (2022)", () => {
    expect(daysOf("יום העצמאות", 2022)).toEqual(["2022-05-05"]);
    expect(daysOf("יום הזיכרון", 2022)).toEqual(["2022-05-04"]);
  });

  it("5 Iyar on Shabbat: Yom HaAtzmaut on Thursday 3 Iyar (2008, 2025)", () => {
    expect(daysOf("יום העצמאות", 2008)).toEqual(["2008-05-08"]);
    expect(daysOf("יום הזיכרון", 2008)).toEqual(["2008-05-07"]);
    expect(daysOf("יום העצמאות", 2025)).toEqual(["2025-05-01"]);
    expect(daysOf("יום הזיכרון", 2025)).toEqual(["2025-04-30"]);
  });

  it("27 Nisan on Friday: Yom HaShoah on Thursday (2008, 2025)", () => {
    expect(daysOf("יום השואה", 2008)).toEqual(["2008-05-01"]);
    expect(daysOf("יום השואה", 2025)).toEqual(["2025-04-24"]);
  });

  it("9 Av on Shabbat: the fast is on Sunday (2022, 2029)", () => {
    expect(daysOf("תשעה באב", 2022)).toEqual([]);
    expect(daysOf("תשעה באב (נדחה)", 2022)).toEqual(["2022-08-07"]);
    expect(daysOf("תשעה באב (נדחה)", 2029)).toEqual(["2029-07-22"]);
    expect(on("2029-07-21")).toEqual([]);
    // 9 Av on Sunday is not "postponed"
    expect(daysOf("תשעה באב", 2025)).toEqual(["2025-08-03"]);
  });

  it("every year 2000-2060 has exactly one of each national day, never on Friday or Shabbat", () => {
    for (let year = 2000; year <= 2060; year++) {
      for (const name of ["יום השואה", "יום הזיכרון", "יום העצמאות"]) {
        const days = daysOf(name, year);
        expect(days, `${name} ${year}`).toHaveLength(1);
        const w = new Date(`${days[0]}T00:00:00Z`).getUTCDay();
        expect([5, 6], `${name} ${year} on ${days[0]}`).not.toContain(w);
      }
      const zikaron = daysOf("יום הזיכרון", year)[0];
      expect(daysOf("יום העצמאות", year)[0], String(year)).toBe(addDays(zikaron, 1));
    }
  });
});

// An independent check of the arithmetic: the platform's own Hebrew calendar
// (ICU through Intl) must agree with it on every day it gets right.
const ICU_MONTHS: Record<string, number> = {
  Tishri: 1, Heshvan: 2, Kislev: 3, Tevet: 4, Shevat: 5, "Adar I": 6, "Adar II": 7, Adar: 7,
  Nisan: 8, Iyar: 9, Sivan: 10, Tamuz: 11, Av: 12, Elul: 13,
};
const icu = new Intl.DateTimeFormat("en-u-ca-hebrew", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
function icuDate(day: string) {
  const parts = icu.formatToParts(new Date(`${day}T12:00:00Z`));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { year: Number(value("year") || value("relatedYear")), month: ICU_MONTHS[value("month")], day: Number(value("day")) };
}

describe("the Hebrew date", () => {
  it("matches the platform's Hebrew calendar every day of 2000-2044", () => {
    let day = "2000-01-01";
    const wrong: string[] = [];
    while (day <= "2044-12-31") {
      const ours = hebrewDate(day)!;
      const theirs = icuDate(day);
      if (ours.year !== theirs.year || ours.month !== theirs.month || ours.day !== theirs.day) wrong.push(day);
      day = addDays(day, 1);
    }
    expect(wrong).toEqual([]);
  });

  it("gets 5807 right, where ICU 77 does not", () => {
    // 5806 starts on Tuesday 12 Sep 2045 and is a leap year; a leap year that
    // starts on a Tuesday is 384 days long, so 5807 starts on Monday 1 Oct 2046
    expect(hebrewDate("2045-09-12")).toEqual({ year: 5806, month: 1, day: 1, leap: true });
    expect(hebrewDate("2046-10-01")).toEqual({ year: 5807, month: 1, day: 1, leap: false });
    expect(hebrewDate("2046-09-30")).toEqual({ year: 5806, month: 13, day: 29, leap: true });
    expect(hebrewDate("2047-09-21")).toEqual({ year: 5808, month: 1, day: 1, leap: false });
  });

  it("Rosh Hashana 2000-2140 falls only on Monday, Tuesday, Thursday or Shabbat", () => {
    for (let year = 2000; year <= 2140; year++) {
      // 1 Tishrei is always in September or early October
      const days = holidaysInRange(`${year}-09-01`, `${year}-10-10`).filter((h) => h.name === "ראש השנה");
      expect(days, String(year)).toHaveLength(2);
      expect([1, 2, 4, 6], String(year)).toContain(new Date(`${days[0].date}T00:00:00Z`).getUTCDay());
      const first = hebrewDate(days[0].date)!;
      expect(first.month === 1 && first.day === 1).toBe(true);
    }
  });

  it("Chanukah has eight days every year, whatever the length of Kislev", () => {
    for (let year = 2020; year <= 2060; year++) {
      const days = holidaysInRange(`${year}-11-15`, `${year + 1}-01-10`).filter((h) => h.name === "חנוכה");
      expect(days, String(year)).toHaveLength(8);
      expect(days[7].date).toBe(addDays(days[0].date, 7));
    }
  });

  it("Pesach is 163 days before the next Rosh Hashana", () => {
    for (let year = 2000; year <= 2060; year++) {
      const pesach = daysOf("פסח", year)[0];
      expect(on(addDays(pesach, 163)), String(year)).toEqual(["ראש השנה:rest"]);
    }
  });
});

describe("Hebrew date labels", () => {
  it("writes the day in Hebrew letters", () => {
    expect(hebrewNumeral(1)).toBe("א׳");
    expect(hebrewNumeral(10)).toBe("י׳");
    expect(hebrewNumeral(15)).toBe("ט״ו");
    expect(hebrewNumeral(16)).toBe("ט״ז");
    expect(hebrewNumeral(27)).toBe("כ״ז");
    expect(hebrewNumeral(30)).toBe("ל׳");
  });

  it("names the month, with Adar II in a leap year", () => {
    expect(hebrewDayLabel("2026-09-26")).toBe("ט״ו בתשרי");
    expect(hebrewDayLabel("2027-03-23")).toBe("י״ד באדר ב׳");
    expect(hebrewDayLabel("2027-02-21")).toBe("י״ד באדר א׳");
    expect(hebrewDayLabel("2026-03-03")).toBe("י״ד באדר");
    expect(hebrewDayLabel("not a day")).toBe("");
  });
});

describe("ranges", () => {
  it("includes both ends and keeps date order", () => {
    const days = holidaysInRange("2026-09-11", "2026-09-13").map((h) => h.date);
    expect(days).toEqual(["2026-09-11", "2026-09-12", "2026-09-13"]);
  });

  it("returns nothing for a bad range", () => {
    expect(holidaysInRange("2026-10-01", "2026-09-01")).toEqual([]);
    expect(holidaysInRange("2026-13-01", "2026-12-31")).toEqual([]);
    expect(holidaysInRange("", "2026-12-31")).toEqual([]);
  });

  it("stops after MAX_RANGE_DAYS days", () => {
    const all = holidaysInRange("2026-01-01", "2035-12-31");
    expect(all.at(-1)!.date < addDays("2026-01-01", MAX_RANGE_DAYS)).toBe(true);
  });

  it("groups by day for a grid", () => {
    const map = holidaysByDay("2026-09-01", "2026-09-30");
    expect(map.get("2026-09-12")?.map((h) => h.name)).toEqual(["ראש השנה"]);
    expect(map.has("2026-09-14")).toBe(false);
  });
});

describe("the organization's rest days", () => {
  const saturdayOnly: CalendarSettings = { restWeekdays: [6], holidaysRest: true, holidayEvesRest: false, restOccasions: [] };

  it("defaults to Friday and Saturday, holidays off, erev days at work", () => {
    expect(restDays(DEFAULT_CALENDAR_SETTINGS)).toEqual([5, 6]);
    // a plain Friday and Saturday
    expect(isRestDay("2026-10-16")).toBe(true);
    expect(isRestDay("2026-10-17")).toBe(true);
    // a plain Sunday
    expect(isRestDay("2026-10-18")).toBe(false);
    // Yom Kippur 2026 is a Monday
    expect(restReason("2026-09-21")).toEqual({ kind: "holiday", holiday: holidaysOn("2026-09-21")[0] });
    // erev Yom Kippur is a Sunday, a work day by default
    expect(isRestDay("2026-09-20")).toBe(false);
    // Yom HaAtzmaut is a day off; Yom HaZikaron and chol hamoed are not
    expect(isRestDay("2026-04-22")).toBe(true);
    expect(isRestDay("2026-04-21")).toBe(false);
    expect(isRestDay("2026-09-28")).toBe(false);
  });

  it("Saturday only: Friday is a work day", () => {
    expect(isRestDay("2026-10-16", saturdayOnly)).toBe(false);
    expect(restReason("2026-10-17", saturdayOnly)).toEqual({ kind: "weekly" });
  });

  it("holidays can be work days", () => {
    const open = { ...saturdayOnly, holidaysRest: false };
    expect(isRestDay("2026-09-21", open)).toBe(false);
    // a holiday on Shabbat is still a rest day: it is Shabbat
    expect(restReason("2026-09-12", open)).toEqual({ kind: "weekly" });
  });

  it("erev days can be days off", () => {
    expect(isRestDay("2026-09-20", { ...DEFAULT_CALENDAR_SETTINGS, holidayEvesRest: true })).toBe(true);
    expect(isRestDay("2026-09-20", { ...DEFAULT_CALENDAR_SETTINGS, holidayEvesRest: true, holidaysRest: false })).toBe(true);
  });

  it("Yom HaZikaron is a shortened working day: outside the eves rule, a rest day only when chosen", () => {
    // Tuesday 21 April 2026; Yom HaZikaron 2027 is Tuesday 11 May
    const eves = { ...DEFAULT_CALENDAR_SETTINGS, holidayEvesRest: true };
    for (const day of ["2026-04-21", "2027-05-11"]) {
      expect(holidaysOn(day).map((h) => `${h.key}:${h.kind}`), day).toEqual(["yom_hazikaron:short"]);
      expect(isRestDay(day), day).toBe(false);
      expect(isRestDay(day, eves), day).toBe(false);
    }
    expect(occasionClosed({ key: "yom_hazikaron", kind: "short" }, { ...eves, holidaysRest: true })).toBe(false);
    const chosen = { ...DEFAULT_CALENDAR_SETTINGS, restOccasions: restOccasions(["yom_hazikaron"]) };
    expect(restReason("2026-04-21", chosen)).toEqual({ kind: "holiday", holiday: holidaysOn("2026-04-21")[0] });
    // choosing it closes no eve, and the eves switch still closes the real eves
    expect(isRestDay("2026-09-20", chosen)).toBe(false);
    expect(isRestDay("2026-09-20", eves)).toBe(true);
    // no other occasion is a shortened day
    expect(OCCASIONS.filter((o) => o.kind === "short").map((o) => o.key)).toEqual(["yom_hazikaron"]);
    expect(HOLIDAY_KIND_LABELS.short).toBe("יום עבודה מקוצר");
  });

  it("any occasion can be chosen as a rest day; none is by default", () => {
    // Purim 2026 (Tuesday), chol hamoed Sukkot (Monday), Mimouna (Thursday): work days by default
    for (const day of ["2026-03-03", "2026-09-28", "2026-04-09", "2026-04-05"]) {
      expect(isRestDay(day), day).toBe(false);
    }
    const chosen = { ...DEFAULT_CALENDAR_SETTINGS, restOccasions: restOccasions(["purim", "chol_hamoed_sukkot", "mimouna"]) };
    expect(restReason("2026-03-03", chosen)).toEqual({ kind: "holiday", holiday: holidaysOn("2026-03-03")[0] });
    expect(isRestDay("2026-09-28", chosen)).toBe(true);
    expect(isRestDay("2026-04-09", chosen)).toBe(true);
    // chol hamoed Pesach was not chosen
    expect(isRestDay("2026-04-05", chosen)).toBe(false);
    // one eve without the others
    const oneEve = { ...DEFAULT_CALENDAR_SETTINGS, restOccasions: restOccasions(["pesach_eve"]) };
    expect(isRestDay("2026-04-01", oneEve)).toBe(true);
    expect(isRestDay("2026-09-20", oneEve)).toBe(false);
    // a holiday by law chosen alone, with the holidays switch off
    const kippurOnly = { ...DEFAULT_CALENDAR_SETTINGS, holidaysRest: false, restOccasions: restOccasions(["yom_kippur"]) };
    expect(isRestDay("2026-09-21", kippurOnly)).toBe(true);
    expect(isRestDay("2026-04-22", kippurOnly)).toBe(false);
    expect(occasionClosed({ key: "purim", kind: "observance" }, chosen)).toBe(true);
    expect(occasionClosed({ key: "purim", kind: "observance" }, DEFAULT_CALENDAR_SETTINGS)).toBe(false);
  });

  it("a business may have no rest day at all", () => {
    const never: CalendarSettings = { restWeekdays: [], holidaysRest: false, holidayEvesRest: false, restOccasions: [] };
    let day = "2026-01-01";
    for (let i = 0; i < 400; i++, day = addDays(day, 1)) {
      expect(restReason(day, never), day).toBeNull();
    }
  });

  it("reads the saved row: unknown and repeated occasions dropped, list order kept, no row is the defaults", () => {
    expect(calendarSettingsFromRow(null)).toEqual(DEFAULT_CALENDAR_SETTINGS);
    expect(DEFAULT_CALENDAR_SETTINGS.restOccasions).toEqual([]);
    expect(
      calendarSettingsFromRow({
        rest_weekdays: [6, 6, 9],
        holidays_rest: false,
        holiday_eves_rest: true,
        rest_occasions: ["mimouna", "no_such_day", "purim", "mimouna"],
      }),
    ).toEqual({ restWeekdays: [6], holidaysRest: false, holidayEvesRest: true, restOccasions: ["purim", "mimouna"] });
    expect(calendarSettingsFromRow({ rest_weekdays: [], holidays_rest: false, holiday_eves_rest: false, rest_occasions: null }).restOccasions).toEqual([]);
    expect(restOccasions([1, null, "chanukah"])).toEqual(["chanukah"]);
  });

  it("cleans the weekly days: no repeats, in order, never all seven", () => {
    expect(restDays({ restWeekdays: [6, 5, 6] })).toEqual([5, 6]);
    expect(restDays({ restWeekdays: [] })).toEqual([]);
    expect(restDays({ restWeekdays: [0, 1, 2, 3, 4, 5, 6] })).toEqual([5, 6]);
    expect(restDays({ restWeekdays: [7, -1, 2.5, 0] as never })).toEqual([0]);
  });

  it("a bad day is never a rest day", () => {
    expect(isRestDay("2026-02-30")).toBe(false);
  });
});

describe("holiday spans for a list", () => {
  it("joins consecutive days of the same holiday", () => {
    const spans = holidaySpans(holidaysInRange("2026-09-11", "2026-10-03"));
    expect(spans.map((s) => `${s.name} ${s.from}${s.to === s.from ? "" : `..${s.to}`}`)).toEqual([
      "ערב ראש השנה 2026-09-11",
      "ראש השנה 2026-09-12..2026-09-13",
      "ערב יום כיפור 2026-09-20",
      "יום כיפור 2026-09-21",
      "ערב סוכות 2026-09-25",
      "סוכות 2026-09-26",
      "חול המועד סוכות 2026-09-27..2026-10-01",
      "הושענא רבה 2026-10-02",
      "שמחת תורה 2026-10-03",
    ]);
  });

  it("keeps the memorial mark", () => {
    expect(holidaySpans(holidaysInRange("2026-04-21", "2026-04-22"))).toEqual([
      { from: "2026-04-21", to: "2026-04-21", key: "yom_hazikaron", name: "יום הזיכרון", kind: "short", memorial: true },
      { from: "2026-04-22", to: "2026-04-22", key: "yom_haatzmaut", name: "יום העצמאות", kind: "rest" },
    ]);
  });
});

describe("the settings form", () => {
  const form = (entries: [string, string][]) => {
    const data = new FormData();
    for (const [key, value] of entries) data.append(key, value);
    return calendarSettingsSchema.safeParse(calendarSettingsFromForm(data));
  };

  it("reads checked weekdays and the two switches", () => {
    const parsed = form([["rest_weekdays", "6"], ["rest_weekdays", "5"], ["holidays_rest", "on"]]);
    expect(parsed.success && parsed.data).toEqual({ rest_weekdays: [5, 6], holidays_rest: true, holiday_eves_rest: false, rest_occasions: [] });
  });

  it("reads the occasions chosen one by one, in list order, without repeats", () => {
    const parsed = form([["rest_occasions", "mimouna"], ["rest_occasions", "purim"], ["rest_occasions", "mimouna"], ["rest_occasions", "chol_hamoed_pesach"]]);
    expect(parsed.success && parsed.data.rest_occasions).toEqual(["purim", "chol_hamoed_pesach", "mimouna"]);
  });

  it("refuses an occasion it does not know", () => {
    const parsed = form([["rest_occasions", "christmas"]]);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(/מועד/);
  });

  it("allows a business that works every day", () => {
    const parsed = form([]);
    expect(parsed.success && parsed.data).toEqual({ rest_weekdays: [], holidays_rest: false, holiday_eves_rest: false, rest_occasions: [] });
  });

  it("refuses all seven days and days out of range", () => {
    expect(form(["0", "1", "2", "3", "4", "5", "6"].map((d) => ["rest_weekdays", d])).success).toBe(false);
    expect(form([["rest_weekdays", "7"]]).success).toBe(false);
    expect(form([["rest_weekdays", "x"]]).success).toBe(false);
  });
});
