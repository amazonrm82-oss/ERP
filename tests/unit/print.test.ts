import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { printedAtText, printedFileLine, printsTimelineEntry, printTimeText } from "@/features/print/print";

describe("printed at line (GAP-11)", () => {
  // 21:30 UTC on 13 October 2026 is already the 14th in Jerusalem (UTC+3 in summer time)
  const at = new Date("2026-10-13T21:30:00Z");

  it("uses the business's time zone for the date and the time", () => {
    const text = printedAtText(at, "Asia/Jerusalem");
    expect(text.startsWith("הודפס ב-")).toBe(true);
    expect(text).toContain("14");
    expect(text).toContain("2026");
    expect(text.endsWith(", 00:30")).toBe(true);
  });

  it("follows another zone", () => {
    const text = printedAtText(at, "America/New_York");
    expect(text).toContain("13");
    expect(text.endsWith(", 17:30")).toBe(true);
  });

  it("falls back to Israel time for a zone the browser does not know", () => {
    expect(printedAtText(at, "Not/AZone")).toBe(printedAtText(at, "Asia/Jerusalem"));
  });
});

describe("agenda time on paper (GAP-11)", () => {
  it("shows a meeting's span and a task's time", () => {
    expect(printTimeText({ startsAt: "2026-10-14T06:00:00Z", endsAt: "2026-10-14T07:30:00Z" }, "Asia/Jerusalem")).toBe("09:00–10:30");
    expect(printTimeText({ startsAt: "2026-10-14T11:00:00Z", endsAt: null }, "Asia/Jerusalem")).toBe("14:00");
  });

  it("keeps the 24-hour clock after the clock change", () => {
    // 26 October 2026: Israel is back on UTC+2
    expect(printTimeText({ startsAt: "2026-10-26T13:15:00Z", endsAt: null }, "Asia/Jerusalem")).toBe("15:15");
  });
});

describe("timeline entries on paper (GAP-11)", () => {
  const me = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";

  it("prints every entry that is not private", () => {
    expect(printsTimelineEntry({ isPrivate: false, createdBy: other }, me)).toBe(true);
    expect(printsTimelineEntry({ isPrivate: false, createdBy: null }, me)).toBe(true);
  });

  it("prints a private note only for the one who wrote it", () => {
    expect(printsTimelineEntry({ isPrivate: true, createdBy: me }, me)).toBe(true);
    expect(printsTimelineEntry({ isPrivate: true, createdBy: other }, me)).toBe(false);
    expect(printsTimelineEntry({ isPrivate: true, createdBy: null }, me)).toBe(false);
  });
});

describe("files on paper (GAP-11, owner 14 October 2026)", () => {
  it("prints the date and who uploaded the file", () => {
    expect(printedFileLine("14 באוק׳ 2026, 09:05", "רונית לוי")).toBe("14 באוק׳ 2026, 09:05 · הועלה על ידי רונית לוי");
  });

  it("prints only the date when the uploader is unknown", () => {
    expect(printedFileLine("14 באוק׳ 2026, 09:05", null)).toBe("14 באוק׳ 2026, 09:05");
    expect(printedFileLine("14 באוק׳ 2026, 09:05", "  ")).toBe("14 באוק׳ 2026, 09:05");
  });
});

describe("print stylesheet (GAP-11)", () => {
  const css = readFileSync(join(process.cwd(), "src/features/print/print.css"), "utf8");
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");

  it("is all inside one @media print block", () => {
    expect(body.trim().startsWith("@media print {")).toBe(true);
    expect(body.match(/@media/g)).toHaveLength(1);
    expect(body.trim().endsWith("}")).toBe(true);
  });

  it("scopes every rule to a page that carries the print marker", () => {
    const inner = body.trim().replace(/^@media print \{/, "").replace(/\}\s*$/, "");
    const selectors = [...inner.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((m) => m[1].trim()).filter((s) => !s.startsWith("@page"));
    expect(selectors.length).toBeGreaterThan(5);
    for (const group of selectors) {
      for (const selector of group.split(",")) {
        expect(selector.trim(), selector).toMatch(/^html(\[data-theme\])?:has\(\[data-print-page\]\)/);
      }
    }
  });

  it("uses no colour outside the design tokens", () => {
    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
  });
});
