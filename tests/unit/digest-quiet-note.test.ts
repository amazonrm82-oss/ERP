import { describe, expect, it } from "vitest";

import { DIGEST_QUIET_HELD, DIGEST_QUIET_SENT_ANYWAY, digestQuietNote, timeInQuietHours } from "@/features/digest/quiet-note";

import { latestMigrationText } from "./helpers/migrations";

// USR-11 / owner (380) א: the note beside the daily summary's time when it falls inside the person's quiet hours.

describe("timeInQuietHours", () => {
  it("is outside when quiet hours are off, broken or empty", () => {
    expect(timeInQuietHours("07:30", null, null)).toBe("outside");
    expect(timeInQuietHours("07:30", "07:00", null)).toBe("outside");
    expect(timeInQuietHours("07:30", "07:00", "07:00")).toBe("outside");
    expect(timeInQuietHours("07:30", "7:00", "09:00")).toBe("outside");
    expect(timeInQuietHours("bad", "07:00", "09:00")).toBe("outside");
  });

  it("a same-day window [from, until) holds the summary to its end", () => {
    expect(timeInQuietHours("07:00", "07:00", "09:00")).toBe("held_until_end");
    expect(timeInQuietHours("08:45", "07:00", "09:00")).toBe("held_until_end");
    expect(timeInQuietHours("09:00", "07:00", "09:00")).toBe("outside");
    expect(timeInQuietHours("06:45", "07:00", "09:00")).toBe("outside");
  });

  it("a window crossing midnight: the part after `from` ends tomorrow (sent anyway), the part before `until` ends today (held)", () => {
    expect(timeInQuietHours("06:00", "22:00", "07:00")).toBe("held_until_end");
    expect(timeInQuietHours("07:00", "22:00", "07:00")).toBe("outside");
    expect(timeInQuietHours("12:00", "22:00", "07:00")).toBe("outside");
    expect(timeInQuietHours("10:00", "09:00", "08:00")).toBe("sent_anyway");
    expect(timeInQuietHours("09:00", "09:00", "08:00")).toBe("sent_anyway");
    expect(timeInQuietHours("07:30", "09:00", "08:00")).toBe("held_until_end");
    expect(timeInQuietHours("08:30", "09:00", "08:00")).toBe("outside");
    expect(timeInQuietHours("23:00", "22:00", "07:00")).toBe("sent_anyway");
  });
});

describe("digestQuietNote", () => {
  it("says nothing outside the window or without quiet hours", () => {
    expect(digestQuietNote("07:30", null)).toBeNull();
    expect(digestQuietNote("07:30", { from: "22:00", until: "07:00" })).toBeNull();
  });

  it("says the owner's words when the window ends on the next day", () => {
    expect(digestQuietNote("10:00", { from: "09:00", until: "08:00" })).toBe("השעה בתוך שעות השקט שלך; הסיכום יישלח בכל זאת");
    expect(DIGEST_QUIET_SENT_ANYWAY).toBe("השעה בתוך שעות השקט שלך; הסיכום יישלח בכל זאת");
  });

  it("says the summary waits for the end when the window ends the same day", () => {
    expect(digestQuietNote("06:00", { from: "22:00", until: "07:00" })).toBe(`${DIGEST_QUIET_HELD} (07:00)`);
    expect(digestQuietNote("08:00", { from: "07:00", until: "09:30" })).toBe("הסיכום יישלח בסוף שעות השקט (09:30)");
  });
});

describe("the rule follows the database", () => {
  it("app.digest_run_at waits for the end only when it is on the same business day", () => {
    const sql = latestMigrationText("create or replace function app.digest_run_at") ?? "";
    expect(sql).toContain("v_end := app.quiet_hours_end(v_from, v_until, p_zone, p_at);");
    expect(sql).toContain("(v_end at time zone p_zone)::date <> (p_at at time zone p_zone)::date then\n    return p_at;");
  });

  it("app.quiet_hours_end ends a window crossing midnight tomorrow after `from` and today before `until`", () => {
    const sql = latestMigrationText("create or replace function app.quiet_hours_end") ?? "";
    expect(sql).toContain("elsif v_time >= p_from then\n    v_end_local := (v_day + 1) + p_until;");
    expect(sql).toContain("elsif v_time < p_until then\n    v_end_local := v_day + p_until;");
  });
});
