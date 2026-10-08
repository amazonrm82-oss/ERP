import { describe, expect, it } from "vitest";

import { endOfToday, zoneDate, zonedIso, zoneTime } from "@/lib/format";

// Israel: summer time ends on 25 October 2026 (02:00 -> 01:00) and starts on
// 26 March 2027 (02:00 -> 03:00). Midnight and noon have different offsets on
// those days (FXC-04).
describe("zonedIso in Asia/Jerusalem", () => {
  it("an ordinary winter and summer day", () => {
    expect(zonedIso("2026-01-15", "00:00:00")).toBe("2026-01-14T22:00:00.000Z");
    expect(zonedIso("2026-07-15", "00:00:00")).toBe("2026-07-14T21:00:00.000Z");
    expect(zonedIso("2026-07-15", "09:30:00")).toBe("2026-07-15T06:30:00.000Z");
  });

  it("midnight on the day summer time ends is still summer time", () => {
    expect(zonedIso("2026-10-25", "00:00:00")).toBe("2026-10-24T21:00:00.000Z");
    expect(zoneTime(new Date(zonedIso("2026-10-25", "00:00:00")))).toBe("00:00");
    // after the change the same day is in winter time
    expect(zonedIso("2026-10-25", "12:00:00")).toBe("2026-10-25T10:00:00.000Z");
    expect(zonedIso("2026-10-25", "23:59:59.999")).toBe("2026-10-25T21:59:59.999Z");
  });

  it("midnight on the day summer time starts is still winter time", () => {
    expect(zonedIso("2027-03-26", "00:00:00")).toBe("2027-03-25T22:00:00.000Z");
    expect(zoneDate(new Date(zonedIso("2027-03-26", "00:00:00")))).toBe("2027-03-26");
    expect(zonedIso("2027-03-26", "12:00:00")).toBe("2027-03-26T09:00:00.000Z");
  });

  it("a day is 25 hours long when summer time ends and 23 when it starts", () => {
    const hours = (day: string, next: string) => (Date.parse(zonedIso(next, "00:00:00")) - Date.parse(zonedIso(day, "00:00:00"))) / 3_600_000;
    expect(hours("2026-10-25", "2026-10-26")).toBe(25);
    expect(hours("2027-03-26", "2027-03-27")).toBe(23);
    expect(hours("2026-10-20", "2026-10-21")).toBe(24);
  });

  it("another zone", () => {
    expect(zonedIso("2026-03-29", "00:00:00", "Europe/London")).toBe("2026-03-29T00:00:00.000Z");
    expect(zonedIso("2026-03-30", "00:00:00", "Europe/London")).toBe("2026-03-29T23:00:00.000Z");
    expect(zonedIso("2026-06-01", "00:00:00", "UTC")).toBe("2026-06-01T00:00:00.000Z");
  });

  it("end of today in the zone", () => {
    expect(endOfToday(new Date("2026-10-25T10:00:00Z"))).toBe("2026-10-25T21:59:59.999Z");
    // 23:30 UTC on 24 October is already the 25th in Jerusalem
    expect(endOfToday(new Date("2026-10-24T23:30:00Z"))).toBe("2026-10-25T21:59:59.999Z");
  });
});
