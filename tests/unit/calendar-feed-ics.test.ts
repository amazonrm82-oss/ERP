import { describe, expect, it } from "vitest";

import { tokenFromFile } from "@/features/calendar-feed/feed-server";
import {
  buildIcs,
  escapeIcsText,
  foldIcsLine,
  icsDateTime,
  icsDisposition,
  isFeedToken,
  meetingSequence,
  meetingUid,
  quoteIcsParam,
  type IcsEvent,
} from "@/features/calendar-feed/ics";

const meeting: IcsEvent = {
  id: "0b6f8f9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
  title: "פגישת היכרות",
  startsAt: "2026-11-03T08:30:00.000Z",
  endsAt: "2026-11-03T09:15:00.000Z",
  location: "רחוב הרצל 1, תל אביב",
  videoUrl: null,
  status: "planned",
  updatedAt: "2026-10-13T10:00:00.000Z",
};
const now = new Date("2026-10-13T12:00:00.000Z");

// unfolds per RFC 5545 3.1, so the content can be checked line by line
const unfold = (text: string) => text.replace(/\r\n[ \t]/g, "").split("\r\n");

describe("calendar files (CAL-07)", () => {
  it("escapes TEXT values: backslash first, then semicolon, comma and line breaks", () => {
    expect(escapeIcsText("a\\b;c,d")).toBe("a\\\\b\\;c\\,d");
    expect(escapeIcsText("שורה\r\nשנייה\nשלישית\rרביעית")).toBe("שורה\\nשנייה\\nשלישית\\nרביעית");
    // a colon needs no escape in TEXT; control characters are dropped
    expect(escapeIcsText("09:00\u0007")).toBe("09:00");
  });

  it("quotes a parameter and drops double quotes", () => {
    expect(quoteIcsParam('שיפוצים "הבית" בע"מ; תל אביב')).toBe('"שיפוצים הבית בעמ; תל אביב"');
  });

  it("folds lines at 75 octets without splitting a Hebrew character", () => {
    const line = `SUMMARY:${"א".repeat(100)}`;
    const folded = foldIcsLine(line);
    const parts = folded.split("\r\n");
    expect(parts.length).toBeGreaterThan(1);
    for (const [index, part] of parts.entries()) {
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
      if (index > 0) expect(part.startsWith(" ")).toBe(true);
      expect(part).not.toContain("�");
    }
    expect(unfold(folded)).toEqual([line]);
    expect(foldIcsLine("SHORT:line")).toBe("SHORT:line");
  });

  it("writes times in UTC", () => {
    expect(icsDateTime("2026-11-03T08:30:00.000Z")).toBe("20261103T083000Z");
    // an offset is turned into UTC (23:30 Israel summer time is 20:30 UTC)
    expect(icsDateTime("2026-09-01T23:30:00+03:00")).toBe("20260901T203000Z");
  });

  it("builds a published calendar with one event", () => {
    const text = buildIcs({ events: [meeting], now, organizer: { name: "שיפוצי הצפון", email: "dana@example.com" } });
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    const lines = unfold(text.trimEnd());
    expect(lines).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Mexuz//CRM//HE",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:${meetingUid(meeting.id)}`,
      "DTSTAMP:20261013T120000Z",
      "DTSTART:20261103T083000Z",
      "DTEND:20261103T091500Z",
      `SEQUENCE:${meetingSequence(meeting.updatedAt)}`,
      "SUMMARY:פגישת היכרות",
      "LAST-MODIFIED:20261013T100000Z",
      "LOCATION:רחוב הרצל 1\\, תל אביב",
      'ORGANIZER;CN="שיפוצי הצפון":mailto:dana@example.com',
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
      "END:VEVENT",
      "END:VCALENDAR",
    ]);
  });

  it("a feed names the calendar, asks for hourly refresh, and marks a cancelled meeting", () => {
    const cancelled = { ...meeting, id: "1b6f8f9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", status: "cancelled", location: null, videoUrl: "https://meet.example/abc?x=1" };
    const lines = unfold(buildIcs({ name: "Mexuz · עסק; שלי", timeZone: "Asia/Jerusalem", refresh: true, events: [meeting, cancelled], now }));
    expect(lines).toContain("X-WR-CALNAME:Mexuz · עסק\\; שלי");
    expect(lines).toContain("X-WR-TIMEZONE:Asia/Jerusalem");
    expect(lines).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT1H");
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(2);
    expect(lines).toContain("STATUS:CANCELLED");
    // no place: the video link is the location, and also the URL and the text
    expect(lines).toContain("LOCATION:https://meet.example/abc?x=1");
    expect(lines).toContain("URL:https://meet.example/abc?x=1");
    expect(lines).toContain("DESCRIPTION:קישור לשיחת הווידאו: https://meet.example/abc?x=1");
    // a feed has no organizer
    expect(lines.some((l) => l.startsWith("ORGANIZER"))).toBe(false);
  });

  it("drops what could break a line: a bad video link, a bad organizer address, a bad zone", () => {
    const lines = unfold(
      buildIcs({
        timeZone: "Asia/Jerusalem\r\nX-EVIL:1",
        events: [{ ...meeting, title: "כותרת\r\nX-EVIL:1", videoUrl: "javascript:alert(1)" }],
        organizer: { name: "עסק", email: "a@b.c\r\nX-EVIL:1" },
        now,
      }),
    );
    expect(lines.some((l) => l.startsWith("X-EVIL"))).toBe(false);
    expect(lines.some((l) => l.startsWith("URL:"))).toBe(false);
    expect(lines.some((l) => l.startsWith("ORGANIZER"))).toBe(false);
    expect(lines.some((l) => l.startsWith("X-WR-TIMEZONE"))).toBe(false);
    expect(lines).toContain("SUMMARY:כותרת\\nX-EVIL:1");
  });

  it("the same meeting keeps its UID, and a change raises its SEQUENCE", () => {
    expect(meetingUid(meeting.id)).toBe(meetingUid(meeting.id));
    expect(meetingSequence("2026-10-13T10:00:01Z")).toBe(meetingSequence("2026-10-13T10:00:00Z") + 1);
    expect(meetingSequence(null)).toBe(0);
    expect(meetingSequence("2088-01-01T00:00:00Z")).toBeLessThan(2 ** 31);
  });

  it("names the downloaded file safely", () => {
    expect(icsDisposition('פגישה/עם "דנה"')).toBe(`attachment; filename="meeting.ics"; filename*=UTF-8''${encodeURIComponent("פגישהעם דנה.ics")}`);
  });

  it("accepts only a well-formed feed token in the path", () => {
    const token = "A".repeat(40) + "b-_9".repeat(6);
    expect(isFeedToken(token)).toBe(true);
    expect(tokenFromFile(`${token}.ics`)).toBe(token);
    expect(tokenFromFile(token)).toBe(token);
    expect(tokenFromFile(`${token.slice(1)}.ics`)).toBeNull();
    expect(tokenFromFile(`${token.slice(1)}=.ics`)).toBeNull();
    expect(tokenFromFile("../../etc/passwd")).toBeNull();
  });
});
