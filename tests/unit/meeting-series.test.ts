import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { mergeConflictReports, type ConflictReport } from "@/features/meetings/conflicts";
import {
  lastSeriesDate,
  movesDay,
  seriesCountSchema,
  seriesLabel,
  seriesScopeSchema,
  SERIES_MAX,
  SERIES_MIN,
  shiftToTimes,
  weeklySeriesTimes,
} from "@/features/meetings/series";

const TZ = "Asia/Jerusalem";

describe("weekly meeting series (CAL-09)", () => {
  it("keeps the wall-clock time every week, across the clock change", () => {
    // Israel moves back an hour on Sunday 25 October 2026
    const times = weeklySeriesTimes("2026-10-18", "10:00", "10:45", TZ, 3);
    expect(times).toEqual([
      { starts_at: "2026-10-18T07:00:00.000Z", ends_at: "2026-10-18T07:45:00.000Z" },
      { starts_at: "2026-10-25T08:00:00.000Z", ends_at: "2026-10-25T08:45:00.000Z" },
      { starts_at: "2026-11-01T08:00:00.000Z", ends_at: "2026-11-01T08:45:00.000Z" },
    ]);
    expect(weeklySeriesTimes("2026-12-31", "09:00", "10:00", TZ, SERIES_MAX)).toHaveLength(SERIES_MAX);
    expect(lastSeriesDate("2026-10-18", 3)).toBe("2026-11-01");
    expect(lastSeriesDate("2026-12-31", 2)).toBe("2027-01-07");
  });

  it("reads the count and the scope from the form", () => {
    expect(seriesCountSchema.safeParse(" 10 ").data).toBe(10);
    for (const bad of ["1", "53", "2.5", "", "abc"]) expect(seriesCountSchema.safeParse(bad).success, bad).toBe(false);
    expect(seriesScopeSchema.parse("following")).toBe("following");
    expect(seriesScopeSchema.parse(null)).toBe("one");
    expect(seriesScopeSchema.parse("all")).toBe("one");
    expect(seriesLabel(3)).toBe("פגישה 3 בסדרה שבועית");
  });

  it("moves a following meeting to the new time of day on its own date", () => {
    // stored 10:00 Israel time on 1 November (winter)
    expect(shiftToTimes("2026-11-01T08:00:00Z", "12:30", "13:15", TZ)).toEqual({
      starts_at: "2026-11-01T10:30:00.000Z",
      ends_at: "2026-11-01T11:15:00.000Z",
    });
    expect(movesDay("2026-11-01T08:00:00Z", "2026-11-01", TZ)).toBe(false);
    expect(movesDay("2026-11-01T08:00:00Z", "2026-11-02", TZ)).toBe(true);
    // 23:30 Israel time on 1 November is still the 1st there
    expect(movesDay("2026-11-01T21:30:00Z", "2026-11-01", TZ)).toBe(false);
  });

  it("the limits are the database's", () => {
    const dir = path.join(process.cwd(), "supabase", "migrations");
    const sql = readFileSync(path.join(dir, readdirSync(dir).find((f) => f.endsWith("_meeting_series.sql"))!), "utf8");
    expect(sql).toContain(`series_index between 1 and ${SERIES_MAX}`);
    expect(sql).toContain(`jsonb_array_length(p_times) not between ${SERIES_MIN} and ${SERIES_MAX}`);
  });
});

describe("one conflict warning for a series (CAL-09)", () => {
  const meeting = (id: string, startsAt: string) => ({ meetingId: id, title: id, startsAt, endsAt: startsAt });
  const report = (people: ConflictReport["people"], restDays: ConflictReport["restDays"] = []): ConflictReport => ({ people, restDays });

  it("merges the weeks: each meeting once, hidden and hours kept, rest days in order", () => {
    const merged = mergeConflictReports([
      report([{ userId: "u1", name: "דנה", meetings: [meeting("m2", "2026-11-08T08:00:00Z")], hidden: false, hours: null }], [{ day: "2026-11-14", holiday: null }]),
      null,
      report(
        [
          { userId: "u1", name: "דנה", meetings: [meeting("m1", "2026-11-01T08:00:00Z"), meeting("m2", "2026-11-08T08:00:00Z")], hidden: true, hours: "outside" },
          { userId: "u2", name: "יוסי", meetings: [], hidden: false, hours: "day_off" },
        ],
        [{ day: "2026-11-07", holiday: null }, { day: "2026-11-14", holiday: null }],
      ),
    ]);
    expect(merged?.people.map((p) => [p.userId, p.meetings.map((m) => m.meetingId), p.hidden, p.hours])).toEqual([
      ["u1", ["m1", "m2"], true, "outside"],
      ["u2", [], false, "day_off"],
    ]);
    expect(merged?.restDays.map((r) => r.day)).toEqual(["2026-11-07", "2026-11-14"]);
  });

  it("nothing to warn about is null", () => {
    expect(mergeConflictReports([null, null])).toBeNull();
    expect(mergeConflictReports([])).toBeNull();
  });
});

describe("rest days in a series warning (CAL-09, owner 15 October 2026)", () => {
  const TZ2 = "Asia/Jerusalem";
  const restDays = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ day: new Date(Date.UTC(2026, 10, 7 + 7 * i)).toISOString().slice(0, 10), holiday: null }));
  const span = { startsAt: "2026-11-07T08:00:00Z", endsAt: "2026-11-07T09:00:00Z" };

  it("names up to ten rest days in the Hebrew date format, then ועוד N", async () => {
    const { conflictLines, REST_DAYS_SHOWN } = await import("@/features/meetings/conflicts");
    const { longDay } = await import("@/lib/calendar-grid");
    expect(REST_DAYS_SHOWN).toBe(10);
    const ten = conflictLines({ people: [], restDays: restDays(10) }, span, TZ2);
    expect(ten).toHaveLength(10);
    expect(ten[0].text).toBe(`${longDay("2026-11-07")}: יום מנוחה בעסק`);
    const twelve = conflictLines({ people: [], restDays: restDays(12) }, span, TZ2);
    expect(twelve).toHaveLength(11);
    expect(twelve[10].text).toBe("ועוד 2 ימי מנוחה או חגים");
    expect(conflictLines({ people: [], restDays: restDays(11) }, span, TZ2)[10].text).toBe("ועוד 1 יום מנוחה או חג");
  });

  it("never moves a meeting of the series to a working day (HEB-02 moves tasks only)", () => {
    // a series that starts on a Saturday keeps every meeting on a Saturday
    const times = weeklySeriesTimes("2026-11-07", "10:00", "11:00", TZ2, 6);
    const days = times.map((t) => new Date(t.starts_at).toLocaleDateString("en-US", { weekday: "long", timeZone: TZ2 }));
    expect(new Set(days)).toEqual(new Set(["Saturday"]));
    // and the "following" shift keeps each meeting's own date
    expect(shiftToTimes(times[3].starts_at, "12:00", "13:00", TZ2).starts_at.slice(0, 10)).toBe(times[3].starts_at.slice(0, 10));
  });
});

describe("series split, skipped dates and delete following (CAL-09, owner 15 October 2026)", () => {
  it("starts the new series on the nearest date on the new weekday, on or after the chosen meeting", async () => {
    const { splitStartDate } = await import("@/features/meetings/series");
    // Sunday 1 November 2026 -> Tuesday: 3 November; -> Sunday's own weekday stays
    expect(splitStartDate("2026-11-01", "2026-11-03")).toBe("2026-11-03");
    // picked a Friday in an earlier week: the next Friday on or after the chosen Sunday
    expect(splitStartDate("2026-11-01", "2026-10-23")).toBe("2026-11-06");
    // Thursday -> Monday wraps to the next week
    expect(splitStartDate("2026-11-05", "2026-11-02")).toBe("2026-11-09");
  });

  it("finds the meetings someone moved by hand", async () => {
    const { movedByHand } = await import("@/features/meetings/series");
    const base = { startsAt: "2026-11-01T08:00:00Z", index: 3 };
    expect(movedByHand(base, { startsAt: "2026-11-15T08:00:00Z", index: 5 }, TZ)).toBe(false);
    expect(movedByHand(base, { startsAt: "2026-11-16T08:00:00Z", index: 5 }, TZ)).toBe(true);
    expect(movedByHand(base, { startsAt: "2026-11-15T09:00:00Z", index: 5 }, TZ)).toBe(true);
  });

  it("says what the split does, counting the hand-moved meetings", async () => {
    const { splitWarningText } = await import("@/features/meetings/series");
    expect(splitWarningText(5, 2, "יום שלישי")).toContain("2 פגישות שהוזזו ידנית יימחקו");
    expect(splitWarningText(5, 0, "יום שלישי")).not.toContain("ידנית");
  });

  it("lists the dates that did not change, ten then ועוד N, with the reason", async () => {
    const { skippedDatesText } = await import("@/features/meetings/series");
    const { longDay } = await import("@/lib/calendar-grid");
    expect(skippedDatesText([])).toBeNull();
    expect(skippedDatesText(["2026-11-08"])).toBe(`פגישה אחת לא השתנתה, אין הרשאה: ${longDay("2026-11-08")}.`);
    const days = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2026, 10, 1 + 7 * i)).toISOString().slice(0, 10));
    const text = skippedDatesText([...days].reverse())!;
    expect(text.startsWith(`12 פגישות לא השתנו, אין הרשאה: ${longDay(days[0])}`)).toBe(true);
    expect(text.endsWith("; ועוד 2.")).toBe(true);
    expect(text).not.toContain(longDay(days[10]));
  });

  it("deletes from this meeting on, never a meeting that already started", async () => {
    const { fromHereNotPast, deleteFollowingText } = await import("@/features/meetings/series");
    const now = Date.parse("2026-11-10T12:00:00Z");
    const rows = [
      { series_index: 4, starts_at: "2026-11-22T08:00:00Z" },
      { series_index: 1, starts_at: "2026-11-01T08:00:00Z" },
      { series_index: 2, starts_at: "2026-11-08T08:00:00Z" },
      { series_index: 3, starts_at: "2026-11-15T08:00:00Z" },
    ];
    expect(fromHereNotPast(rows, 2, now).map((r) => r.series_index)).toEqual([3, 4]);
    expect(fromHereNotPast(rows, 4, now).map((r) => r.series_index)).toEqual([4]);
    expect(fromHereNotPast(rows, 1, Date.parse("2026-12-01T00:00:00Z"))).toEqual([]);
    expect(deleteFollowingText(3)).toContain("3 פגישות יימחקו");
    expect(deleteFollowingText(3)).toContain("בוטלה");
  });
});
