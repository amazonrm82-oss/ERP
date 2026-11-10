import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SHEET_CLOSE_DISTANCE, sheetDragCloses } from "@/components/ui/sheet";
import { fullDateTimeText, relativeTimeText } from "@/lib/relative-time";

// UX-01 phone fixes (owner's iPhone test and "גיליון אחד בטלפון", 10 November 2026)

describe("relative time for \"מגע אחרון\"", () => {
  const zone = "Asia/Jerusalem";
  // 10 November 2026, 15:00 in Jerusalem (13:00 UTC)
  const now = new Date("2026-11-10T13:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  it("minutes, then hours the same day", () => {
    expect(relativeTimeText(ago(10_000), now, zone)).toBe("לפני רגע");
    expect(relativeTimeText(ago(MIN), now, zone)).toBe("לפני דקה");
    expect(relativeTimeText(ago(45 * MIN), now, zone)).toBe("לפני 45 דקות");
    expect(relativeTimeText(ago(HOUR), now, zone)).toBe("לפני שעה");
    expect(relativeTimeText(ago(2 * HOUR), now, zone)).toBe("לפני שעתיים");
    expect(relativeTimeText(ago(3 * HOUR), now, zone)).toBe("לפני 3 שעות");
    // 00:30 the same day in Jerusalem
    expect(relativeTimeText("2026-11-09T22:30:00Z", now, zone)).toBe("לפני 14 שעות");
  });

  it("days by the business's calendar, not by 24 hours", () => {
    // 23:30 yesterday in Jerusalem, only 15.5 hours ago
    expect(relativeTimeText("2026-11-09T21:30:00Z", now, zone)).toBe("אתמול");
    expect(relativeTimeText("2026-11-08T10:00:00Z", now, zone)).toBe("לפני יומיים");
    expect(relativeTimeText("2026-11-05T10:00:00Z", now, zone)).toBe("לפני 5 ימים");
    expect(relativeTimeText("2026-11-03T10:00:00Z", now, zone)).toBe("לפני 7 ימים");
    // the same instant is the same day in Jerusalem (01:30, now 15:00) but yesterday in New York (18:30, now 08:00)
    const nowNy = new Date("2026-11-09T13:00:00Z");
    expect(relativeTimeText("2026-11-08T23:30:00Z", nowNy, zone)).toBe("לפני 13 שעות");
    expect(relativeTimeText("2026-11-08T23:30:00Z", nowNy, "America/New_York")).toBe("אתמול");
  });

  it("past a week a short date, with the year only when it differs", () => {
    const shortDate = relativeTimeText("2026-11-01T10:00:00Z", now, zone);
    expect(shortDate).toMatch(/^1 בנוב/);
    expect(shortDate).not.toMatch(/2026/);
    expect(relativeTimeText("2025-10-20T10:00:00Z", now, zone)).toMatch(/2025/);
  });

  it("the full date and time for the title, in the zone; empty for nothing", () => {
    const full = fullDateTimeText("2026-11-09T21:30:00Z", zone);
    expect(full).toMatch(/9 בנובמבר 2026/);
    expect(full).toMatch(/23:30/);
    expect(relativeTimeText(null, now, zone)).toBe("");
    expect(relativeTimeText("not a date", now, zone)).toBe("");
    expect(relativeTimeText(new Date(now.getTime() + HOUR).toISOString(), now, zone)).toBe("לפני רגע");
  });

  it("the phone's lead cards use it with the business's zone and the full date in title", () => {
    const cards = readFileSync("src/features/leads/components/lead-cards.tsx", "utf8");
    expect(cards).toContain("relativeTimeText(lead.lastContactedAt, at, timeZone)");
    expect(cards).toContain("title: fullDateTimeText(lead.lastContactedAt, timeZone)");
    expect(readFileSync("src/app/o/[orgId]/leads/page.tsx", "utf8")).toContain("timeZone={context.org.timeZone}");
  });
});

describe("the one bottom sheet", () => {
  it("closes on a long drag or a quick flick down, never on a drag up", () => {
    expect(sheetDragCloses(0, 100, 600)).toBe(false);
    expect(sheetDragCloses(-200, 100, 600)).toBe(false);
    expect(sheetDragCloses(SHEET_CLOSE_DISTANCE, 1000, 600)).toBe(true);
    expect(sheetDragCloses(SHEET_CLOSE_DISTANCE - 1, 1000, 600)).toBe(false);
    // a short sheet: a quarter of its height is enough
    expect(sheetDragCloses(50, 1000, 200)).toBe(true);
    // a flick: 40 px in 50 ms
    expect(sheetDragCloses(40, 50, 600)).toBe(true);
    expect(sheetDragCloses(10, 5, 600)).toBe(false);
  });

  it("\"עוד\", every sheet dialog and the side panel on a phone are the same Sheet", () => {
    expect(readFileSync("src/features/shell/components/nav.tsx", "utf8")).toMatch(/<Sheet open=\{moreOpen\}/);
    const dialog = readFileSync("src/components/ui/dialog.tsx", "utf8");
    expect(dialog).toMatch(/props\.variant === "sheet"[\s\S]*<Sheet/);
    expect(dialog).not.toContain("mx-sheet");
    const panel = readFileSync("src/components/ui/side-panel.tsx", "utf8");
    expect(panel).toMatch(/<Sheet[^>]*height="tall"[^>]*below="md"/);
    expect(panel).not.toContain("mx-sheet");
    const sheet = readFileSync("src/components/ui/sheet.tsx", "utf8");
    expect(sheet).toContain('"mx-sheet ');
    expect(readFileSync("src/features/design-gallery/components/gallery.tsx", "utf8")).toMatch(/<Sheet[\s\S]*height=\{sheet \?\? "content"\}/);
  });

  it("a tall sheet is 88% of the visible screen (dvh, never vh) with a fallback for browsers without dvh", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    const rules = css.slice(css.indexOf("A tall sheet"), css.indexOf("/* Charts (DSN-13)"));
    expect(rules).toContain('dialog.mx-sheet[data-sheet-height="tall"][data-sheet-below="md"]');
    expect(rules).toMatch(/height: 88dvh;/);
    expect(rules).toMatch(/@supports not \(height: 1dvh\)/);
    expect(rules).not.toMatch(/\d+vh/);
    expect(readFileSync("src/components/ui/sheet.tsx", "utf8")).toContain('"--mx-sheet-viewport"');
  });
});
