import { describe, expect, it } from "vitest";

import { buildIcs } from "@/features/calendar-feed/ics";
import { inviteOrganizer } from "@/features/calendar-feed/organizer";

const meeting = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "פגישת היכרות",
  startsAt: "2026-10-20T07:00:00Z",
  endsAt: "2026-10-20T08:00:00Z",
  location: null,
  videoUrl: null,
  status: "planned",
  updatedAt: "2026-10-13T08:00:00Z",
};
const now = new Date("2026-10-13T09:00:00Z");

// the unfolded ORGANIZER line of an invite file
function organizerLine(organizer: ReturnType<typeof inviteOrganizer>): string | undefined {
  const text = buildIcs({ events: [meeting], now, organizer }).replace(/\r\n /g, "");
  return text.split("\r\n").find((line) => line.startsWith("ORGANIZER"));
}

// CAL-07 + TAX-02 (owner's answer, 13 October 2026): the business email is the invite's organizer
describe("ORGANIZER of the invite file", () => {
  it("with a business email: that address, named '<organizer>, <business>' and quoted", () => {
    const organizer = inviteOrganizer({
      businessName: 'שיפוצים; "הצפון"',
      businessEmail: "office@example.co.il",
      organizerName: "דנה כהן",
      organizerEmail: "dana@example.com",
    });
    expect(organizer).toEqual({ name: 'דנה כהן, שיפוצים; "הצפון"', email: "office@example.co.il" });
    // the comma and semicolon stay inside the quoted parameter; a double quote cannot appear in one (RFC 5545 3.2)
    expect(organizerLine(organizer)).toBe('ORGANIZER;CN="דנה כהן, שיפוצים; הצפון":mailto:office@example.co.il');
  });

  it("with a business email but no organizer name: the business name alone", () => {
    const organizer = inviteOrganizer({ businessName: "שיפוצי הצפון", businessEmail: "office@example.co.il", organizerName: " ", organizerEmail: null });
    expect(organizerLine(organizer)).toBe('ORGANIZER;CN="שיפוצי הצפון":mailto:office@example.co.il');
  });

  it("without a business email: as before, the organizer's own address under the business name", () => {
    const organizer = inviteOrganizer({ businessName: "שיפוצי הצפון", businessEmail: null, organizerName: "דנה כהן", organizerEmail: "dana@example.com" });
    expect(organizerLine(organizer)).toBe('ORGANIZER;CN="שיפוצי הצפון":mailto:dana@example.com');
  });

  it("an address that could break the line or the URI gives no ORGANIZER line", () => {
    for (const email of ["office\u0001@example.co.il", "office@exa\u007fmple.co.il", 'of"fice@example.co.il', "a@b@example.co.il", "office @example.co.il", "office@example.co.il\r\nX-EVIL:1", "@example.co.il", "office@"]) {
      const organizer = inviteOrganizer({ businessName: "שיפוצי הצפון", businessEmail: email, organizerName: "דנה כהן", organizerEmail: "dana@example.com" });
      expect(organizerLine(organizer), JSON.stringify(email)).toBeUndefined();
    }
  });

  it("with neither address: no ORGANIZER line", () => {
    const organizer = inviteOrganizer({ businessName: "שיפוצי הצפון", businessEmail: "", organizerName: "דנה כהן", organizerEmail: null });
    expect(organizer).toBeNull();
    expect(organizerLine(organizer)).toBeUndefined();
  });
});
