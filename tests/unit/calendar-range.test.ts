import { describe, expect, it } from "vitest";

import { moveTargetSchema } from "@/features/calendar/schema";
import {
  calendarPath,
  daySegments,
  HIDDEN_MEETING_STATUSES,
  HIDDEN_TASK_STATUSES,
  isDoneOrCancelled,
  isOnDay,
  itemsOnDay,
  layoutColumns,
  minutesToTime,
  movedEnd,
  parseDay,
  parseShowDone,
  parseView,
  rangeBounds,
  snapMinutes,
  spanTitle,
  stepDay,
  viewDays,
  viewTitle,
  wallMinutes,
  type TimedItem,
} from "@/features/calendar/range";
import { weekday } from "@/lib/calendar-grid";

const TZ = "Asia/Jerusalem";

const meeting = (id: string, startsAt: string, endsAt: string): TimedItem => ({ id, kind: "meeting", startsAt, endsAt });
const task = (id: string, startsAt: string): TimedItem => ({ id, kind: "task", startsAt, endsAt: null });

describe("calendar URL (CAL-02)", () => {
  it("reads the view and the day, falling back to today", () => {
    expect(parseView("month")).toBe("month");
    expect(parseView("year")).toBeNull();
    expect(parseView(undefined)).toBeNull();
    expect(parseDay("2026-10-12", "2026-01-01")).toBe("2026-10-12");
    expect(parseDay("2026-02-30", "2026-01-01")).toBe("2026-01-01");
    expect(parseDay("", "2026-01-01")).toBe("2026-01-01");
  });

  it("builds the address with view, date and whose calendar", () => {
    expect(calendarPath("o1")).toBe("/o/o1/calendar");
    expect(calendarPath("o1", { view: "week", date: "2026-10-12" })).toBe("/o/o1/calendar?view=week&date=2026-10-12");
    expect(calendarPath("o1", { who: "all" })).toBe("/o/o1/calendar?who=all");
  });

  it("keeps the done switch (done=1) and reads it back", () => {
    expect(calendarPath("o1", { done: false })).toBe("/o/o1/calendar");
    expect(calendarPath("o1", { done: true })).toBe("/o/o1/calendar?done=1");
    const path = calendarPath("o1", { view: "people", date: "2026-10-12", team: "t1", people: ["u1", "u2"], done: true });
    expect(path).toBe("/o/o1/calendar?view=people&date=2026-10-12&team=t1&p=u1&p=u2&done=1");
    const params = new URLSearchParams(path.split("?")[1]);
    expect(parseShowDone(params.get("done") ?? undefined)).toBe(true);
    expect(params.getAll("p")).toEqual(["u1", "u2"]);
    expect(parseShowDone(new URLSearchParams(calendarPath("o1", { who: "all" }).split("?")[1]).get("done") ?? undefined)).toBe(false);
    for (const value of [undefined, "", "0", "true", "yes", "11"]) expect(parseShowDone(value)).toBe(false);
  });

  it("hides done tasks and cancelled or no-show meetings, not held ones (owner, 12 October 2026)", () => {
    expect(isDoneOrCancelled("task", "done")).toBe(true);
    expect(isDoneOrCancelled("task", "open")).toBe(false);
    expect(isDoneOrCancelled("meeting", "cancelled")).toBe(true);
    expect(isDoneOrCancelled("meeting", "no_show")).toBe(true);
    expect(isDoneOrCancelled("meeting", "held")).toBe(false);
    expect(isDoneOrCancelled("meeting", "planned")).toBe(false);
    // statuses of the other kind do not leak across
    expect(isDoneOrCancelled("meeting", "done")).toBe(false);
    expect(isDoneOrCancelled("task", "cancelled")).toBe(false);
    expect([...HIDDEN_MEETING_STATUSES]).toEqual(["cancelled", "no_show"]);
    expect([...HIDDEN_TASK_STATUSES]).toEqual(["done"]);
  });
});

describe("calendar ranges", () => {
  it("a week starts on Sunday, whatever day is picked", () => {
    // Monday 12 October 2026
    const week = viewDays("week", "2026-10-12");
    expect(week).toEqual(["2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"]);
    expect(weekday(week[0])).toBe(0);
    // a Sunday is the first day of its own week, a Saturday the last
    expect(viewDays("week", "2026-10-11")[0]).toBe("2026-10-11");
    expect(viewDays("week", "2026-10-17")[0]).toBe("2026-10-11");
  });

  it("a month is whole weeks from Sunday to Saturday", () => {
    const days = viewDays("month", "2026-10-20");
    expect(days.length % 7).toBe(0);
    expect(days[0]).toBe("2026-09-27");
    expect(days[days.length - 1]).toBe("2026-10-31");
    expect(days).toContain("2026-10-01");
    // February 2026 starts on a Sunday and fills exactly four weeks
    expect(viewDays("month", "2026-02-10")).toHaveLength(28);
  });

  it("steps by the view's length; a month step keeps the day or the month's last", () => {
    expect(stepDay("day", "2026-10-31", 1)).toBe("2026-11-01");
    expect(stepDay("week", "2026-10-12", -1)).toBe("2026-10-05");
    expect(stepDay("month", "2026-01-31", 1)).toBe("2026-02-28");
    expect(stepDay("agenda", "2026-10-12", 1)).toBe("2026-10-26");
    expect(viewDays("agenda", "2026-10-12")).toHaveLength(14);
  });

  it("the range is midnight to midnight in the zone, across the clock change", () => {
    // summer time ends in Israel on Sunday 25 October 2026 (02:00 → 01:00)
    const week = viewDays("week", "2026-10-25");
    const { from, to } = rangeBounds(week, TZ);
    expect(from).toBe("2026-10-24T21:00:00.000Z"); // Sunday 00:00, summer time (+03)
    expect(to).toBe("2026-10-31T22:00:00.000Z"); // next Sunday 00:00, winter time (+02)
    // the day of the change is 25 hours long
    const day = rangeBounds(["2026-10-25"], TZ);
    expect(Date.parse(day.to) - Date.parse(day.from)).toBe(25 * 3_600_000);
  });

  it("names the range in Hebrew", () => {
    expect(viewTitle("month", "2026-10-12")).toBe("אוקטובר 2026");
    expect(viewTitle("week", "2026-10-12")).toBe("11–17 באוקטובר 2026");
    expect(spanTitle("2026-09-27", "2026-10-03")).toBe("27 בספטמבר – 3 באוקטובר 2026");
    expect(spanTitle("2026-12-27", "2027-01-02")).toBe("27 בדצמבר 2026 – 2 בינואר 2027");
    expect(viewTitle("day", "2026-10-12")).toContain("שני");
  });
});

describe("items on days", () => {
  it("a meeting at 23:30 Israel time is on its own day on both sides of the clock change", () => {
    // 24 Oct (summer, +03) and 26 Oct (winter, +02)
    const summer = meeting("a", "2026-10-24T20:30:00Z", "2026-10-24T20:59:00Z");
    const winter = meeting("b", "2026-10-26T21:30:00Z", "2026-10-26T21:59:00Z");
    expect(isOnDay(summer, "2026-10-24", TZ)).toBe(true);
    expect(isOnDay(summer, "2026-10-25", TZ)).toBe(false);
    expect(isOnDay(winter, "2026-10-26", TZ)).toBe(true);
    expect(isOnDay(winter, "2026-10-27", TZ)).toBe(false);
    expect(wallMinutes(new Date(winter.startsAt), TZ)).toBe(23 * 60 + 30);
  });

  it("a task is on the day it is due, in the zone", () => {
    // 22:30 UTC on 31 Oct is 00:30 on 1 Nov in Jerusalem
    const t = task("t", "2026-10-31T22:30:00Z");
    expect(itemsOnDay([t], "2026-11-01", TZ)).toHaveLength(1);
    expect(itemsOnDay([t], "2026-10-31", TZ)).toHaveLength(0);
  });

  it("a meeting that ends exactly at midnight is not on the next day", () => {
    const m = meeting("m", "2026-11-01T20:00:00Z", "2026-11-01T22:00:00Z"); // 22:00–00:00
    expect(isOnDay(m, "2026-11-01", TZ)).toBe(true);
    expect(isOnDay(m, "2026-11-02", TZ)).toBe(false);
  });

  it("places items by wall-clock time, also on the clock change day", () => {
    // 10:00–11:00 on 25 October, after the change (+02)
    const [segment] = daySegments([meeting("m", "2026-10-25T08:00:00Z", "2026-10-25T09:00:00Z")], "2026-10-25", TZ);
    expect(segment.startMin).toBe(600);
    expect(segment.endMin).toBe(660);
    expect(segment.startsHere).toBe(true);
  });

  it("a meeting over midnight is drawn on both days; the second part is a continuation", () => {
    const m = meeting("m", "2026-11-01T21:30:00Z", "2026-11-01T23:00:00Z"); // 23:30–01:00
    const [first] = daySegments([m], "2026-11-01", TZ);
    const [second] = daySegments([m], "2026-11-02", TZ);
    expect([first.startMin, first.endMin, first.startsHere]).toEqual([1410, 1440, true]);
    expect([second.startMin, second.endMin, second.startsHere]).toEqual([0, 60, false]);
  });

  it("a task takes half an hour on the grid, never past midnight", () => {
    const [late] = daySegments([task("t", "2026-11-01T21:50:00Z")], "2026-11-01", TZ); // 23:50
    expect([late.startMin, late.endMin]).toEqual([1430, 1440]);
  });

  it("items at the same time sit side by side", () => {
    const segments = layoutColumns([
      { startMin: 600, endMin: 660, column: 0, columns: 1 },
      { startMin: 630, endMin: 690, column: 0, columns: 1 },
      { startMin: 660, endMin: 720, column: 0, columns: 1 },
      { startMin: 800, endMin: 860, column: 0, columns: 1 },
    ]);
    expect(segments.map((s) => [s.column, s.columns])).toEqual([
      [0, 2],
      [1, 2],
      [0, 2],
      [0, 1],
    ]);
  });
});

describe("moving", () => {
  it("snaps to a quarter of an hour within the day", () => {
    expect(snapMinutes(0, 1440)).toBe(0);
    expect(snapMinutes(607, 1440)).toBe(600);
    expect(snapMinutes(608, 1440)).toBe(615);
    expect(snapMinutes(-50, 1440)).toBe(0);
    expect(snapMinutes(5000, 1440)).toBe(1425);
    expect(minutesToTime(615)).toBe("10:15");
    expect(minutesToTime(0)).toBe("00:00");
  });

  it("a moved meeting keeps its length, across the clock change too", () => {
    expect(movedEnd("2026-10-20T07:00:00Z", "2026-10-20T08:30:00Z", "2026-10-27T08:00:00Z")).toBe("2026-10-27T09:30:00.000Z");
  });

  it("checks the move target from the browser", () => {
    expect(moveTargetSchema.safeParse({ kind: "meeting", date: "2026-10-12", time: "09:15" }).success).toBe(true);
    expect(moveTargetSchema.safeParse({ kind: "task", date: "2026-02-30", time: "09:15" }).success).toBe(false);
    expect(moveTargetSchema.safeParse({ kind: "task", date: "2026-10-12", time: "24:00" }).success).toBe(false);
    expect(moveTargetSchema.safeParse({ kind: "deal", date: "2026-10-12", time: "09:00" }).success).toBe(false);
    expect(moveTargetSchema.safeParse({ kind: "task", date: "2026-10-12", time: "09:00", extra: 1 }).success).toBe(false);
  });
});
