import { describe, expect, it } from "vitest";

import { DEFAULT_CALENDAR_SETTINGS, holidaysOn, type CalendarSettings } from "@/features/calendar-days/holidays";
import {
  conflictLines,
  conflictReport,
  overlaps,
  restDayIssues,
  workingHoursIssue,
  zoneDaysOf,
  type BusyRow,
  type ConflictPerson,
  type Span,
} from "@/features/meetings/conflicts";
import type { WorkingHours } from "@/features/profile/working-hours";
import { zonedIso } from "@/lib/format";

const TZ = "Asia/Jerusalem";
// every day a work day, so rest days stay out of the tests that are not about them
const NO_REST: CalendarSettings = { restWeekdays: [], holidaysRest: false, holidayEvesRest: false, restOccasions: [] };

const at = (day: string, time: string, zone = TZ) => zonedIso(day, `${time}:00`, zone);
const span = (day: string, from: string, to: string, endDay = day): Span => ({ startsAt: at(day, from), endsAt: at(endDay, to) });

const SUN_THU: WorkingHours = {
  sun: [{ start: "09:00", end: "17:00" }],
  mon: [{ start: "09:00", end: "17:00" }],
  tue: [{ start: "09:00", end: "17:00" }],
  wed: [{ start: "09:00", end: "17:00" }],
  thu: [{ start: "09:00", end: "17:00" }],
};
const SPLIT: WorkingHours = {
  sun: [
    { start: "08:00", end: "12:00" },
    { start: "16:00", end: "19:00" },
  ],
};

describe("overlap (CAL-05)", () => {
  it("overlapping times clash; back to back does not", () => {
    expect(overlaps(span("2026-10-18", "10:00", "11:00"), span("2026-10-18", "10:30", "11:30"))).toBe(true);
    expect(overlaps(span("2026-10-18", "10:00", "11:00"), span("2026-10-18", "09:00", "12:00"))).toBe(true);
    expect(overlaps(span("2026-10-18", "10:00", "11:00"), span("2026-10-18", "11:00", "12:00"))).toBe(false);
    expect(overlaps(span("2026-10-18", "11:00", "12:00"), span("2026-10-18", "10:00", "11:00"))).toBe(false);
    expect(overlaps(span("2026-10-18", "10:00", "11:00"), span("2026-10-18", "12:00", "13:00"))).toBe(false);
  });
});

describe("days in the zone", () => {
  it("a meeting that ends at midnight stays on its day; one that crosses midnight takes two", () => {
    expect(zoneDaysOf(span("2026-10-18", "22:00", "00:00", "2026-10-19"), TZ)).toEqual(["2026-10-18"]);
    expect(zoneDaysOf(span("2026-10-18", "23:00", "01:00", "2026-10-19"), TZ)).toEqual(["2026-10-18", "2026-10-19"]);
  });

  it("days are read in the zone, not in UTC", () => {
    // 01:00 in Jerusalem on the 19th is still the 18th in UTC
    expect(zoneDaysOf(span("2026-10-19", "01:00", "02:00"), TZ)).toEqual(["2026-10-19"]);
  });
});

describe("working hours (CAL-05 with USR-01)", () => {
  it("no hours set: no warning", () => {
    expect(workingHoursIssue(span("2026-10-24", "03:00", "04:00"), null, TZ)).toBeNull();
  });

  it("inside the hours, at their edges too, is fine", () => {
    expect(workingHoursIssue(span("2026-10-18", "09:00", "17:00"), SUN_THU, TZ)).toBeNull();
    expect(workingHoursIssue(span("2026-10-18", "10:00", "11:00"), SUN_THU, TZ)).toBeNull();
  });

  it("starting early or ending late is outside", () => {
    expect(workingHoursIssue(span("2026-10-18", "08:30", "09:30"), SUN_THU, TZ)).toBe("outside");
    expect(workingHoursIssue(span("2026-10-18", "16:30", "17:30"), SUN_THU, TZ)).toBe("outside");
    expect(workingHoursIssue(span("2026-10-18", "18:00", "19:00"), SUN_THU, TZ)).toBe("outside");
  });

  it("a day with no hours is a day off", () => {
    expect(workingHoursIssue(span("2026-10-23", "10:00", "11:00"), SUN_THU, TZ)).toBe("day_off");
    expect(workingHoursIssue(span("2026-10-24", "10:00", "11:00"), SUN_THU, TZ)).toBe("day_off");
  });

  it("split hours: inside either range is fine, the gap between them is outside", () => {
    expect(workingHoursIssue(span("2026-10-18", "08:30", "11:30"), SPLIT, TZ)).toBeNull();
    expect(workingHoursIssue(span("2026-10-18", "17:00", "19:00"), SPLIT, TZ)).toBeNull();
    expect(workingHoursIssue(span("2026-10-18", "13:00", "14:00"), SPLIT, TZ)).toBe("outside");
    expect(workingHoursIssue(span("2026-10-18", "11:00", "16:30"), SPLIT, TZ)).toBe("outside");
  });

  it("ranges that touch count as one stretch", () => {
    const touching: WorkingHours = {
      sun: [
        { start: "08:00", end: "12:00" },
        { start: "12:00", end: "16:00" },
      ],
    };
    expect(workingHoursIssue(span("2026-10-18", "11:00", "13:00"), touching, TZ)).toBeNull();
  });

  it("a meeting across midnight needs both days' hours", () => {
    const late: WorkingHours = { sun: [{ start: "20:00", end: "23:59" }], mon: [{ start: "00:00", end: "02:00" }] };
    expect(workingHoursIssue(span("2026-10-18", "23:00", "01:00", "2026-10-19"), late, TZ)).toBeNull();
    // Monday not worked: a day off
    expect(workingHoursIssue(span("2026-10-18", "23:00", "01:00", "2026-10-19"), { sun: late.sun }, TZ)).toBe("day_off");
    // Monday worked from 01:00 only: the first hour is outside
    expect(workingHoursIssue(span("2026-10-18", "23:00", "01:30", "2026-10-19"), { sun: late.sun, mon: [{ start: "01:00", end: "05:00" }] }, TZ)).toBe(
      "outside",
    );
  });

  it("the clock change day keeps wall-clock hours", () => {
    // summer time ends on Sunday 25 October 2026 at 02:00
    expect(workingHoursIssue(span("2026-10-25", "16:00", "17:00"), SUN_THU, TZ)).toBeNull();
    expect(workingHoursIssue(span("2026-10-25", "08:00", "09:00"), SUN_THU, TZ)).toBe("outside");
  });

  it("hours are read in the person's own zone", () => {
    // 10:00 in Jerusalem is 08:00 in London (summer): before a London 09:00 start
    const meeting = span("2026-10-18", "10:00", "11:00");
    expect(workingHoursIssue(meeting, SUN_THU, TZ)).toBeNull();
    expect(workingHoursIssue(meeting, SUN_THU, "Europe/London")).toBe("outside");
  });
});

describe("rest days of the business (CAL-05 with CAL-03)", () => {
  it("the weekly rest days of the settings", () => {
    expect(restDayIssues(span("2026-10-24", "10:00", "11:00"), DEFAULT_CALENDAR_SETTINGS, TZ)).toEqual([{ day: "2026-10-24", holiday: null }]);
    expect(restDayIssues(span("2026-10-18", "10:00", "11:00"), DEFAULT_CALENDAR_SETTINGS, TZ)).toEqual([]);
    expect(restDayIssues(span("2026-10-24", "10:00", "11:00"), NO_REST, TZ)).toEqual([]);
  });

  it("a holiday that is a rest day, by name", () => {
    const [holiday] = holidaysOn("2026-09-21").filter((h) => h.kind === "rest");
    expect(holiday).toBeDefined();
    expect(restDayIssues(span("2026-09-21", "10:00", "11:00"), DEFAULT_CALENDAR_SETTINGS, TZ)).toEqual([{ day: "2026-09-21", holiday: holiday.name }]);
  });
});

describe("the report", () => {
  const dana: ConflictPerson = { userId: "u-dana", name: "דנה", hours: SUN_THU, timeZone: TZ };
  const yossi: ConflictPerson = { userId: "u-yossi", name: "יוסי", hours: null, timeZone: TZ };
  const meeting = span("2026-10-18", "10:00", "11:00");
  const busy: BusyRow[] = [
    { userId: "u-yossi", meetingId: "m-seen", title: "סקירת לקוח", ...span("2026-10-18", "10:30", "11:30") },
    // a meeting the user may not see: no id, no title
    { userId: "u-yossi", meetingId: null, title: null, ...span("2026-10-18", "09:00", "10:15") },
    { userId: "u-yossi", meetingId: null, title: null, ...span("2026-10-18", "10:45", "12:00") },
    // back to back: not a conflict
    { userId: "u-dana", meetingId: "m-before", title: "פגישת בוקר", ...span("2026-10-18", "09:00", "10:00") },
    { userId: "u-dana", meetingId: null, title: null, ...span("2026-10-18", "11:00", "12:00") },
    // the meeting itself
    { userId: "u-dana", meetingId: "m-self", title: "הפגישה עצמה", ...meeting },
  ];

  it("nothing to say: null", () => {
    expect(conflictReport({ span: meeting, people: [dana, yossi], busy: [], settings: NO_REST, timeZone: TZ })).toBeNull();
    expect(conflictReport({ span: meeting, people: [dana], busy, excludeId: "m-self", settings: NO_REST, timeZone: TZ })).toBeNull();
  });

  it("names the people, hides meetings the user may not see, skips the meeting itself", () => {
    const report = conflictReport({ span: meeting, people: [dana, yossi, yossi], busy, excludeId: "m-self", settings: NO_REST, timeZone: TZ });
    expect(report).not.toBeNull();
    expect(report!.people).toHaveLength(1);
    expect(report!.people[0]).toMatchObject({ userId: "u-yossi", hours: null, hidden: true });
    expect(report!.people[0].meetings.map((m) => [m.meetingId, m.title])).toEqual([["m-seen", "סקירת לקוח"]]);

    const lines = conflictLines(report!, meeting, TZ);
    expect(lines.map((l) => l.text)).toEqual(['יוסי: פגישה "סקירת לקוח"', "יוסי: יש פגישה אחרת באותו זמן"]);
    expect(lines[0].time).toBe("10:30–11:30");
    // two hidden meetings: one line, no time and no title
    expect(lines[1].time).toBeNull();
  });

  it("working hours and rest days come in the same report", () => {
    const evening = span("2026-10-24", "18:00", "19:00");
    const report = conflictReport({ span: evening, people: [dana, yossi], busy: [], settings: DEFAULT_CALENDAR_SETTINGS, timeZone: TZ });
    expect(report!.people).toEqual([{ userId: "u-dana", name: "דנה", meetings: [], hidden: false, hours: "day_off" }]);
    expect(report!.restDays).toEqual([{ day: "2026-10-24", holiday: null }]);
    const lines = conflictLines(report!, evening, TZ).map((l) => l.text);
    expect(lines).toEqual(["דנה: יום חופש לפי שעות העבודה", "יום שבת, 24 באוקטובר 2026: יום מנוחה בעסק"]);
  });

  it("a clashing meeting on another day says which day", () => {
    const long = span("2026-10-18", "10:00", "10:00", "2026-10-20");
    const report = conflictReport({
      span: long,
      people: [yossi],
      busy: [{ userId: "u-yossi", meetingId: "m-seen", title: "סקירת לקוח", ...span("2026-10-19", "12:00", "13:00") }],
      settings: NO_REST,
      timeZone: TZ,
    });
    const [line] = conflictLines(report!, long, TZ);
    expect(line.text).toBe('יוסי: פגישה "סקירת לקוח", יום שני, 19 באוקטובר 2026');
    expect(line.time).toBeNull();
  });
});
