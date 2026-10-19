import { describe, expect, it } from "vitest";

import type { CalendarItem } from "@/features/calendar/queries";
import { dealsWithoutNextStep, idleText, meetingSpanText, myMeetings, STUCK_ROWS_LIMIT } from "@/features/home/my-day";

const TZ = "Asia/Jerusalem";

function row(id: string, noNextStep: boolean, extra: Record<string, unknown> = {}) {
  return { id, name: `עסקה ${id}`, stage_name: "הצעה", idle_days: 3, stuck: false, no_next_step: noNextStep, ...extra };
}

describe("deals without a next action (TASK-09)", () => {
  it("keeps only the deals the database marked as having no task and no planned meeting, in its order", () => {
    const result = dealsWithoutNextStep([row("a", true), row("b", false, { stuck: true }), row("c", true, { idle_days: 0 })], 8);
    expect(result.deals.map((d) => d.id)).toEqual(["a", "c"]);
    expect(result.count).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.deals[0]).toEqual({ id: "a", name: "עסקה a", stageName: "הצעה", idleDays: 3 });
  });

  it("caps the list but counts them all", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(String(i), true));
    const result = dealsWithoutNextStep(rows, 8);
    expect(result.deals).toHaveLength(8);
    expect(result.count).toBe(12);
  });

  it("says when the function stopped at its limit", () => {
    const rows = Array.from({ length: STUCK_ROWS_LIMIT }, (_, i) => row(String(i), i % 2 === 0));
    expect(dealsWithoutNextStep(rows, 8).truncated).toBe(true);
  });

  it("reads anything malformed as nothing", () => {
    expect(dealsWithoutNextStep(null, 8)).toEqual({ deals: [], count: 0, truncated: false });
    expect(dealsWithoutNextStep({ id: "x" }, 8).count).toBe(0);
    const result = dealsWithoutNextStep(
      [{ no_next_step: true }, { id: "", no_next_step: true }, { id: "z", no_next_step: "yes" }, row("ok", true, { name: " ", stage_name: null, idle_days: -2.5 })],
      8,
    );
    expect(result.deals).toEqual([{ id: "ok", name: "עסקה ללא שם", stageName: null, idleDays: 0 }]);
  });

  it("says how long the deal has been idle", () => {
    expect(idleText(0)).toBe("פעילות אחרונה היום");
    expect(idleText(1)).toBe("בלי פעילות יום אחד");
    expect(idleText(12)).toBe("בלי פעילות 12 ימים");
  });
});

function item(id: string, kind: "meeting" | "task", startsAt: string, endsAt: string | null, block = false): CalendarItem {
  return { id, kind, startsAt, endsAt, title: id, status: "planned", type: "phone", meetingTypeId: null, activityTypeId: null, location: null, ownerName: null, related: null, people: [], block };
}

describe("today's meetings leave blocked time out (GAP-07)", () => {
  it("a block is not a meeting to attend", () => {
    const now = new Date("2026-10-13T09:30:00Z");
    const result = myMeetings(
      [item("block", "meeting", "2026-10-13T12:00:00Z", "2026-10-13T13:00:00Z", true), item("real", "meeting", "2026-10-13T14:00:00Z", "2026-10-13T15:00:00Z")],
      now,
    );
    expect(result.map((m) => m.id)).toEqual(["real"]);
  });
});

describe("today's meetings (TASK-09)", () => {
  const now = new Date("2026-10-13T09:30:00Z"); // 12:30 in Israel

  it("lists meetings only, by start, with where each one stands now", () => {
    const result = myMeetings(
      [
        item("later", "meeting", "2026-10-13T12:00:00Z", "2026-10-13T13:00:00Z"),
        item("task", "task", "2026-10-13T08:00:00Z", null),
        item("now", "meeting", "2026-10-13T09:00:00Z", "2026-10-13T10:00:00Z"),
        item("over", "meeting", "2026-10-13T06:00:00Z", "2026-10-13T09:30:00Z"),
      ],
      now,
    );
    expect(result.map((m) => [m.id, m.phase])).toEqual([
      ["over", "over"],
      ["now", "now"],
      ["later", "upcoming"],
    ]);
  });

  it("writes the times in the organization's zone, with the date of a side on another day", () => {
    expect(meetingSpanText("2026-10-13T06:00:00Z", "2026-10-13T07:00:00Z", "2026-10-13", TZ)).toBe("09:00–10:00");
    expect(meetingSpanText("2026-10-12T20:00:00Z", "2026-10-13T06:00:00Z", "2026-10-13", TZ)).toBe("12.10 23:00–09:00");
    expect(meetingSpanText("2026-10-13T20:00:00Z", "2026-10-13T22:00:00Z", "2026-10-13", TZ)).toBe("23:00–14.10 01:00");
    expect(meetingSpanText("2026-10-13T06:00:00Z", "2026-10-13T07:00:00Z", "2026-10-13", "Europe/London")).toBe("07:00–08:00");
  });
});
