import { describe, expect, it } from "vitest";

import { DEFAULT_CALENDAR_SETTINGS, type CalendarSettings } from "@/features/calendar-days/holidays";
import type { WorkingHours } from "@/features/profile/working-hours";
import { DEFAULT_ORG_HOURS, hoursCover, memberInHours, outOfHoursReason, wallClock, workingDaysOnly, type HoursInput } from "@/features/work-hours/in-hours";
import { onLeave, parseLeave } from "@/features/work-hours/leave";

const base: Omit<HoursInput, "at"> = {
  orgTimeZone: "Asia/Jerusalem",
  calendar: DEFAULT_CALENDAR_SETTINGS,
  orgHours: null,
  userTimeZone: null,
  userHours: null,
  leaves: [],
};
const at = (iso: string, over: Partial<HoursInput> = {}) => outOfHoursReason({ ...base, ...over, at: new Date(iso) });
const OPEN: CalendarSettings = { restWeekdays: [], holidaysRest: false, holidayEvesRest: false, restOccasions: [] };

// CAP-09: the TS side of app.member_in_hours(); tests/db/100 compares the two on a grid.
describe("working hours (CAP-09)", () => {
  it("reads the wall clock of a zone, across midnight and the clock change", () => {
    expect(wallClock(new Date("2026-10-18T21:30:00Z"), "Asia/Jerusalem")).toEqual({ date: "2026-10-19", weekday: 1, time: "00:30:00" });
    expect(wallClock(new Date("2026-10-18T21:30:00Z"), "America/New_York")).toEqual({ date: "2026-10-18", weekday: 0, time: "17:30:00" });
    // Israel goes back to UTC+2 on Sunday 25 October 2026
    expect(wallClock(new Date("2026-10-26T06:00:00Z"), "Asia/Jerusalem").time).toBe("08:00:00");
  });

  it("a range covers its start up to its end; 23:59 runs to midnight; a missing day is off", () => {
    const hours: WorkingHours = { sun: [{ start: "09:00", end: "12:00" }, { start: "16:00", end: "23:59" }] };
    expect(hoursCover(hours, 0, "09:00:00")).toBe(true);
    expect(hoursCover(hours, 0, "11:59:59")).toBe(true);
    expect(hoursCover(hours, 0, "12:00:00")).toBe(false);
    expect(hoursCover(hours, 0, "23:59:59")).toBe(true);
    expect(hoursCover(hours, 1, "10:00:00")).toBe(false);
  });

  it("no hours set anywhere: no limit, rest days and holidays included (as before CAP-09)", () => {
    expect(at("2026-10-18T00:00:00Z")).toBeNull(); // Sunday 03:00 in Israel
    expect(at("2026-10-16T08:00:00Z")).toBeNull(); // Friday
    expect(at("2026-09-21T08:00:00Z")).toBeNull(); // Yom Kippur
    expect(at("2026-10-18T00:00:00Z", { leaves: [{ startsOn: "2026-10-18", endsOn: "2026-10-18" }] })).toBe("leave");
  });

  it("the business's hours, once set: in its zone, closed on its rest days", () => {
    const org = { orgHours: DEFAULT_ORG_HOURS };
    expect(at("2026-10-18T05:00:00Z", org)).toBeNull(); // Sunday 08:00 in Israel
    expect(at("2026-10-18T04:59:59Z", org)).toBe("outside");
    expect(at("2026-10-18T15:00:00Z", org)).toBe("outside"); // 18:00
    expect(at("2026-10-16T08:00:00Z", org)).toBe("rest_day"); // Friday
    expect(at("2026-09-21T08:00:00Z", org)).toBe("rest_day"); // Yom Kippur
    expect(at("2026-09-21T08:00:00Z", { ...org, calendar: { ...DEFAULT_CALENDAR_SETTINGS, holidaysRest: false } })).toBeNull();
  });

  it("own hours are read in the person's zone; rest days by the business's date", () => {
    const sundayNight: WorkingHours = { sun: [{ start: "22:00", end: "23:59" }] };
    expect(at("2026-10-18T20:30:00Z", { userHours: sundayNight })).toBeNull();
    expect(at("2026-10-18T21:30:00Z", { userHours: sundayNight })).toBe("outside");
    expect(at("2026-10-19T03:30:00Z", { userHours: sundayNight, userTimeZone: "America/New_York" })).toBeNull();
    // Saturday in New York, already Sunday in Israel: a working day of the business
    const allSat: WorkingHours = { sat: [{ start: "00:00", end: "23:59" }] };
    expect(at("2026-10-17T22:30:00Z", { userHours: allSat, userTimeZone: "America/New_York" })).toBeNull();
    // and the other way: Saturday in Israel is closed, whatever the person's hours
    expect(at("2026-10-17T12:00:00Z", { userHours: allSat, userTimeZone: "America/New_York" })).toBe("rest_day");
  });

  it("a leave covers both ends, by the person's date", () => {
    const leaves = [{ startsOn: "2026-10-20", endsOn: "2026-10-21" }];
    const over = { calendar: OPEN, orgHours: DEFAULT_ORG_HOURS, userTimeZone: "Asia/Tokyo", leaves };
    expect(at("2026-10-19T14:59:00Z", { ...over, orgHours: { mon: [{ start: "00:00", end: "23:59" }] } })).toBeNull();
    expect(at("2026-10-20T01:00:00Z", over)).toBe("leave");
    expect(at("2026-10-21T14:59:00Z", over)).toBe("leave");
    expect(memberInHours({ ...base, ...over, at: new Date("2026-10-22T08:00:00Z") })).toBe(true);
    expect(onLeave("2026-10-21", leaves)).toBe(true);
    expect(onLeave("2026-10-22", leaves)).toBe(false);
  });

  it("an unknown zone reads as Israel, like app.intake_zone()", () => {
    expect(at("2026-10-18T05:00:00Z", { orgTimeZone: "Mars/Olympus", orgHours: DEFAULT_ORG_HOURS })).toBeNull();
  });

  it("the business's default hours show on its working days only", () => {
    expect(Object.keys(workingDaysOnly(DEFAULT_ORG_HOURS, DEFAULT_CALENDAR_SETTINGS))).toEqual(["sun", "mon", "tue", "wed", "thu"]);
    expect(Object.keys(workingDaysOnly(DEFAULT_ORG_HOURS, OPEN))).toHaveLength(7);
  });
});

describe("leave form (CAP-09)", () => {
  it("needs a first day; a missing last day is a one-day leave", () => {
    expect(parseLeave("", "")).toMatchObject({ ok: false, field: "starts_on" });
    expect(parseLeave("2026-12-01", "")).toEqual({ ok: true, startsOn: "2026-12-01", endsOn: "2026-12-01" });
    expect(parseLeave("2026-12-01", "2026-12-05")).toEqual({ ok: true, startsOn: "2026-12-01", endsOn: "2026-12-05" });
  });

  it("refuses an end before the start, a bad date and more than a year", () => {
    expect(parseLeave("2026-12-05", "2026-12-01")).toMatchObject({ ok: false, field: "ends_on" });
    expect(parseLeave("2026-02-30", "")).toMatchObject({ ok: false, field: "starts_on" });
    expect(parseLeave("2026-01-01", "2026-12-31")).toMatchObject({ ok: true });
    expect(parseLeave("2026-01-01", "2027-01-01")).toMatchObject({ ok: true }); // 366 days: the database allows ends_on - starts_on <= 365
    expect(parseLeave("2026-01-01", "2027-01-02")).toMatchObject({ ok: false, field: "ends_on" });
  });
});
