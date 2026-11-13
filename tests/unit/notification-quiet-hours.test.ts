import { describe, expect, it } from "vitest";

import { parseQuietHours, quietHoursFromRow, quietHoursSummary, quietTime } from "@/features/notifications/quiet-hours";

// USR-11: the form's reading of quiet hours. The window itself is applied by the database (test 367).
describe("quiet hours on the notification settings form", () => {
  it("reads stored and typed times as HH:MM", () => {
    expect(quietTime("22:00:00")).toBe("22:00");
    expect(quietTime(" 07:30 ")).toBe("07:30");
    expect(quietTime("24:00")).toBeNull();
    expect(quietTime("7:30")).toBeNull();
    expect(quietTime(null)).toBeNull();
  });

  it("a stored pair shows as on only when both ends are set and differ", () => {
    expect(quietHoursFromRow("22:00:00", "07:00:00")).toEqual({ from: "22:00", until: "07:00" });
    expect(quietHoursFromRow(null, null)).toBeNull();
    expect(quietHoursFromRow("22:00:00", null)).toBeNull();
    expect(quietHoursFromRow("08:00:00", "08:00:00")).toBeNull();
  });

  it("off saves nothing; on needs two different valid times", () => {
    expect(parseQuietHours(null, "22:00", "07:00")).toEqual({ ok: true, quiet: null });
    expect(parseQuietHours("on", "22:00", "07:00")).toEqual({ ok: true, quiet: { from: "22:00", until: "07:00" } });
    expect(parseQuietHours("on", "", "07:00")).toMatchObject({ ok: false, field: "quiet_from" });
    expect(parseQuietHours("on", "22:00", "x")).toMatchObject({ ok: false, field: "quiet_until" });
    expect(parseQuietHours("on", "09:00", "09:00")).toMatchObject({ ok: false, field: "quiet_until" });
  });

  it("the summary says when the window crosses midnight", () => {
    expect(quietHoursSummary({ from: "22:00", until: "07:00" })).toContain("למחרת");
    expect(quietHoursSummary({ from: "13:00", until: "16:00" })).not.toContain("למחרת");
    expect(quietHoursSummary(null)).toBe("שעות השקט כבויות.");
  });
});
