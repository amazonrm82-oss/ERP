import { describe, expect, it } from "vitest";

import { formatMeetingWhen, meetingFormTimes } from "@/features/meetings/display";
import { meetingSchema, meetingStatusSchema, meetingTimes, participantIdsSchema, splitMeetings } from "@/features/meetings/schema";

const TZ = "Asia/Jerusalem";

describe("meeting times (CAL-01)", () => {
  it("a meeting at 23:30 Israel time stays on its day on both sides of the clock change", () => {
    // summer time ends on 25 October 2026
    const summer = meetingTimes("2026-10-24", "23:30", "23:59", TZ);
    expect(summer.starts_at).toBe("2026-10-24T20:30:00.000Z");
    const winter = meetingTimes("2026-10-26", "23:30", "23:59", TZ);
    expect(winter.starts_at).toBe("2026-10-26T21:30:00.000Z");
    expect(meetingFormTimes(winter.starts_at, winter.ends_at, TZ)).toEqual({ date: "2026-10-26", start_time: "23:30", end_time: "23:59" });
    expect(meetingFormTimes(summer.starts_at, summer.ends_at, TZ).date).toBe("2026-10-24");
  });

  it("on the day of the change itself, the wall-clock hours are kept", () => {
    const t = meetingTimes("2026-10-25", "10:00", "11:00", TZ);
    expect(t).toEqual({ starts_at: "2026-10-25T08:00:00.000Z", ends_at: "2026-10-25T09:00:00.000Z" });
  });

  it("shows the day and the hours in the organization's zone", () => {
    const text = formatMeetingWhen("2026-11-01T21:30:00Z", "2026-11-01T21:59:00Z", TZ);
    expect(text).toContain("23:30–23:59");
    expect(text).toContain("1");
    // a meeting that crosses midnight names the end day as well
    const late = formatMeetingWhen("2026-11-01T21:30:00Z", "2026-11-01T22:30:00Z", TZ);
    expect(late).toMatch(/23:30–.*00:30$/);
  });
});

describe("meeting form", () => {
  const base = {
    title: "פגישת היכרות",
    meeting_type: "video",
    date: "2026-11-01",
    start_time: "10:00",
    end_time: "11:00",
    location: "",
    video_url: "https://meet.example.test/abc",
    description: "",
  };

  it("accepts a whole meeting and empties the optional fields", () => {
    const parsed = meetingSchema.parse(base);
    expect(parsed.location).toBeNull();
    expect(parsed.video_url).toBe("https://meet.example.test/abc");
  });

  it("refuses an end before the start, a missing date, and a link that is not http(s)", () => {
    const error = (patch: Record<string, string>) => meetingSchema.safeParse({ ...base, ...patch }).error?.issues[0]?.path[0];
    expect(error({ end_time: "09:00" })).toBe("end_time");
    expect(error({ end_time: "10:00" })).toBe("end_time");
    expect(error({ date: "" })).toBe("date");
    expect(error({ date: "2026-02-30" })).toBe("date");
    expect(error({ start_time: "25:00" })).toBe("start_time");
    expect(error({ video_url: "javascript:alert(1)" })).toBe("video_url");
    expect(error({ meeting_type: "zoom" })).toBe("meeting_type");
    expect(error({ title: "  " })).toBe("title");
  });

  it("status and outcome", () => {
    expect(meetingStatusSchema.parse({ status: "no_show", outcome: "" })).toEqual({ status: "no_show", outcome: null });
    expect(meetingStatusSchema.safeParse({ status: "done", outcome: null }).success).toBe(false);
  });

  it("participants: distinct ids only", () => {
    const id = "6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
    expect(participantIdsSchema.parse([id, id])).toEqual([id]);
    expect(participantIdsSchema.safeParse(["x"]).success).toBe(false);
  });
});

describe("splitMeetings", () => {
  it("coming meetings soonest first, past ones latest first; one in progress is still coming", () => {
    const now = new Date("2026-11-01T12:00:00Z");
    const m = (id: string, start: string, end: string) => ({ id, startsAt: start, endsAt: end });
    const { upcoming, past } = splitMeetings(
      [
        m("later", "2026-11-03T10:00:00Z", "2026-11-03T11:00:00Z"),
        m("old", "2026-10-01T10:00:00Z", "2026-10-01T11:00:00Z"),
        m("now", "2026-11-01T11:30:00Z", "2026-11-01T12:30:00Z"),
        m("yesterday", "2026-10-31T10:00:00Z", "2026-10-31T11:00:00Z"),
      ],
      now,
    );
    expect(upcoming.map((x) => x.id)).toEqual(["now", "later"]);
    expect(past.map((x) => x.id)).toEqual(["yesterday", "old"]);
  });
});

describe("meeting errors from the database (CAL-01)", () => {
  it("each trigger error has its own Hebrew message", async () => {
    const { dbErrorMessage, NO_PERMISSION } = await import("@/lib/errors");
    const organizer = dbErrorMessage({ code: "42501", message: "not allowed to change the meeting organizer" });
    const inactive = dbErrorMessage({ code: "23503", message: "meeting organizer must be an active member" });
    const hidden = dbErrorMessage({ code: "42501", message: "meeting linked to a record the user cannot see" });
    expect(organizer).toContain("מי מארגן אותה");
    expect(inactive).toBe("מארגן הפגישה צריך להיות משתמש פעיל בעסק.");
    expect(hidden).toBe("אי אפשר לקשר את הפגישה לרשומה שאין לכם גישה אליה.");
    for (const text of [organizer, inactive, hidden]) expect(text).not.toBe(NO_PERMISSION);
  });
});
