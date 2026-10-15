import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { conflictLines, conflictReport, type BusyRow, type ConflictPerson } from "@/features/meetings/conflicts";
import {
  BUFFER_MAX,
  buffersText,
  DEFAULT_MEETING_TYPES,
  durationText,
  fillFromType,
  isMeetingFormat,
  meetingTypeColor,
  meetingTypeSchema,
  offeredTypes,
  timeAfter,
  type MeetingTypeChoice,
} from "@/features/meeting-types/schema";
import { zonedIso } from "@/lib/format";

const TZ = "Asia/Jerusalem";
const NO_REST = { restWeekdays: [], holidaysRest: false, holidayEvesRest: false, restOccasions: [] };
const at = (time: string) => zonedIso("2026-12-06", `${time}:00`, TZ);

const type = (over: Partial<MeetingTypeChoice> = {}): MeetingTypeChoice => ({
  id: "t1",
  name: "פגישת מכירה",
  durationMinutes: 60,
  format: "in_person",
  location: "המשרד",
  bufferBefore: 0,
  bufferAfter: 0,
  color: "success",
  isActive: true,
  ...over,
});

describe("meeting type helpers (CAL-08)", () => {
  it("adds minutes to a time, capped at the end of the day", () => {
    expect(timeAfter("10:00", 30)).toBe("10:30");
    expect(timeAfter("09:45", 90)).toBe("11:15");
    expect(timeAfter("23:00", 90)).toBe("23:59");
    expect(timeAfter("bad", 30)).toBe("bad");
  });

  it("says a duration and the buffers in plain Hebrew", () => {
    expect(durationText(15)).toBe("15 דקות");
    expect(durationText(60)).toBe("שעה");
    expect(durationText(90)).toBe("1:30 שעות");
    expect(durationText(120)).toBe("שעתיים");
    expect(durationText(180)).toBe("3 שעות");
    expect(buffersText(0, 0)).toBeNull();
    expect(buffersText(15, 0)).toBe("מרווח 15 דק׳ לפני");
    expect(buffersText(10, 20)).toBe("מרווח 10 דק׳ לפני ו-20 דק׳ אחרי");
  });

  it("fills the form from a picked type without losing what the person typed", () => {
    const current = { title: "", format: "phone", location: "", startTime: "10:00", endTime: "11:00" };
    expect(fillFromType(null, type(), current)).toEqual({ title: "פגישת מכירה", format: "in_person", location: "המשרד", endTime: "11:00" });

    // a typed title and location stay; the end follows the duration; a type without a format keeps the format
    const typed = { title: "פגישה עם דנה", format: "video", location: "בית קפה", startTime: "10:00", endTime: "10:30" };
    expect(fillFromType(null, type({ durationMinutes: 45, format: null }), typed)).toEqual({
      title: "פגישה עם דנה",
      format: "video",
      location: "בית קפה",
      endTime: "10:45",
    });

    // switching types replaces what the previous type filled in
    const first = type();
    const second = type({ id: "t2", name: "שיחת טלפון", durationMinutes: 15, format: "phone", location: null });
    const filled = { title: "פגישת מכירה", format: "in_person", location: "המשרד", startTime: "10:00", endTime: "11:00" };
    expect(fillFromType(first, second, filled)).toEqual({ title: "שיחת טלפון", format: "phone", location: "", endTime: "10:15" });

    // back to "no type": nothing changes
    expect(fillFromType(first, null, filled)).toEqual({ title: "פגישת מכירה", format: "in_person", location: "המשרד", endTime: "11:00" });
  });

  it("offers the active types and the meeting's own hidden one", () => {
    const types = [type(), type({ id: "t2", isActive: false }), type({ id: "t3", isActive: false })];
    expect(offeredTypes(types, null).map((t) => t.id)).toEqual(["t1"]);
    expect(offeredTypes(types, "t2").map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("knows only the palette's colours", () => {
    expect(meetingTypeColor("danger")).toBe("danger");
    expect(meetingTypeColor("#ff0000")).toBeNull();
    expect(meetingTypeColor(null)).toBeNull();
  });

  it("checks the settings form", () => {
    const ok = meetingTypeSchema.safeParse({
      name: " ייעוץ ",
      duration_minutes: "45",
      meeting_format: "",
      location: "",
      product_id: "",
      buffer_before_minutes: "",
      buffer_after_minutes: "10",
      color: "accent",
      is_active: "on",
    });
    expect(ok.success && ok.data).toEqual({
      name: "ייעוץ",
      duration_minutes: 45,
      meeting_format: null,
      location: null,
      product_id: null,
      buffer_before_minutes: 0,
      buffer_after_minutes: 10,
      color: "accent",
      is_active: true,
    });
    for (const bad of [{ duration_minutes: "4" }, { duration_minutes: "721" }, { duration_minutes: "1.5" }, { buffer_after_minutes: "241" }, { color: "pink" }, { meeting_format: "zoom" }]) {
      const parsed = meetingTypeSchema.safeParse({ name: "x", duration_minutes: "30", ...bad });
      expect(parsed.success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("keeps the default types equal to the migration's seed", () => {
    const dir = path.join(process.cwd(), "supabase", "migrations");
    const file = readdirSync(dir).find((f) => f.endsWith("_meeting_types.sql"));
    const sql = readFileSync(path.join(dir, file!), "utf8");
    DEFAULT_MEETING_TYPES.forEach((t, i) => {
      expect(sql).toContain(`('${t.name}', ${t.minutes}, '${t.format}', '${t.color}', ${i})`);
    });
    // four defaults, each in its own colour, each format a known one
    expect(DEFAULT_MEETING_TYPES).toHaveLength(4);
    expect(new Set(DEFAULT_MEETING_TYPES.map((t) => t.color)).size).toBe(4);
    expect(DEFAULT_MEETING_TYPES.every((t) => isMeetingFormat(t.format))).toBe(true);
    expect(DEFAULT_MEETING_TYPES.find((t) => t.format === "video")).toMatchObject({ name: "שיחת וידאו", minutes: 30, color: "danger" });
    // the buffer limit is the table's
    expect(sql).toContain(`check (buffer_before_minutes between 0 and ${BUFFER_MAX})`);
    expect(sql).toContain(`check (buffer_after_minutes between 0 and ${BUFFER_MAX})`);
  });
});

describe("buffers in the conflict warning (CAL-08)", () => {
  const people: ConflictPerson[] = [{ userId: "u1", name: "דנה", hours: null, timeZone: TZ }];
  const row = (from: string, to: string, busyFrom: string, busyTo: string): BusyRow => ({
    userId: "u1",
    meetingId: "m1",
    title: "פגישת שטח",
    startsAt: at(from),
    endsAt: at(to),
    busyFrom: at(busyFrom),
    busyTo: at(busyTo),
  });
  const report = (span: [string, string], busySpan: [string, string] | null, busy: BusyRow[]) =>
    conflictReport({
      span: { startsAt: at(span[0]), endsAt: at(span[1]) },
      busySpan: busySpan ? { startsAt: at(busySpan[0]), endsAt: at(busySpan[1]) } : undefined,
      people,
      busy,
      settings: NO_REST,
      timeZone: TZ,
    });

  it("a meeting that falls into another meeting's buffer clashes, and the warning says so", () => {
    // the other meeting 10:00-11:00 with 15 minutes after; the new one 11:05-11:30
    const found = report(["11:05", "11:30"], null, [row("10:00", "11:00", "10:00", "11:15")]);
    expect(found?.people[0].meetings).toEqual([{ meetingId: "m1", title: "פגישת שטח", startsAt: at("10:00"), endsAt: at("11:00"), buffer: true }]);
    const lines = conflictLines(found!, { startsAt: at("11:05"), endsAt: at("11:30") }, TZ);
    expect(lines[0].text).toBe('דנה: פגישה "פגישת שטח" (במרווח בין הפגישות)');
    expect(lines[0].time).toBe("10:00–11:00");
  });

  it("the new meeting's own buffers may not fall on another meeting", () => {
    // the new meeting 11:10-12:00 needs 15 minutes before; the other one ends at 11:00
    expect(report(["11:10", "12:00"], ["10:55", "12:00"], [row("10:00", "11:00", "10:00", "11:00")])?.people[0].meetings[0].buffer).toBe(true);
    // without that buffer: free
    expect(report(["11:10", "12:00"], null, [row("10:00", "11:00", "10:00", "11:00")])).toBeNull();
  });

  it("two buffers may share the same free time", () => {
    // the other meeting keeps 15 minutes after (to 11:15), the new one 15 minutes before (from 11:05)
    expect(report(["11:20", "12:00"], ["11:05", "12:00"], [row("10:00", "11:00", "10:00", "11:15")])).toBeNull();
  });

  it("a real overlap is not marked as a buffer", () => {
    expect(report(["10:30", "11:30"], null, [row("10:00", "11:00", "09:45", "11:15")])?.people[0].meetings[0].buffer).toBeUndefined();
  });
});
