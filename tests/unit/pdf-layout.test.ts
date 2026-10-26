import { describe, expect, it } from "vitest";

import { bidiType, firstStrong, toVisual } from "@/features/pdf/bidi";
import { ltr } from "@/features/pdf/document";
import { paginate, splitRowLines, type Piece } from "@/features/pdf/paginate";
import { wrapParagraph, wrapText } from "@/features/pdf/text-layout";

// QUO-06: a PDF line is written left to right in visual order. The expected strings below are worked out by hand from
// UAX #9, not by the code under test.

describe("bidi: visual order of one line", () => {
  it("reverses Hebrew and keeps numbers, currency and percent left to right", () => {
    expect(toVisual("שלום עולם")).toBe("םלוע םולש");
    expect(toVisual("מחיר: 1,234.50 ₪")).toBe("₪ 1,234.50 :ריחמ");
    // the app's own money format: RLM, NBSP and ₪
    expect(toVisual("‏1,234.50 ‏₪")).toBe("₪ 1,234.50");
    expect(toVisual("הנחה 12.5%")).toBe("12.5% החנה");
    expect(toVisual("תאריך: 26.10.2026")).toBe("26.10.2026 :ךיראת");
    expect(toVisual("ו-₪100")).toBe("₪100-ו");
  });

  it("keeps a phone and an email marked left to right in one piece, sign first", () => {
    expect(toVisual(`טלפון: ${ltr("+972-50-1234567")}`)).toBe("+972-50-1234567 :ןופלט");
    expect(toVisual(`אימייל: ${ltr("123@example.co.il")}`)).toBe("123@example.co.il :ליימיא");
    // a phone alone in a right-to-left line
    expect(toVisual(ltr("+972-3-555-1234"), "rtl")).toBe("+972-3-555-1234");
  });

  it("keeps English words and their numbers in their own order inside Hebrew", () => {
    expect(toVisual("הצעה עבור Acme Ltd. 2026")).toBe("Acme Ltd. 2026 רובע העצה");
    expect(toVisual("שירות ייעוץ (כולל WiFi 5G)")).toBe("(WiFi 5G ללוכ) ץועיי תוריש");
  });

  it("mirrors brackets in right-to-left runs", () => {
    expect(toVisual("שירות (חודשי)")).toBe("(ישדוח) תוריש");
    expect(toVisual('לקוח (בע"מ)')).toBe('(מ"עב) חוקל');
  });

  it("an English paragraph stays left to right; the direction comes from the first strong letter", () => {
    expect(firstStrong("123 Hello")).toBe("ltr");
    expect(firstStrong("12 שלום")).toBe("rtl");
    expect(firstStrong("123")).toBeNull();
    expect(toVisual("Hello (world).")).toBe("Hello (world).");
    expect(toVisual("Price 12% off, שלום")).toBe("Price 12% off, םולש");
  });

  it("keeps niqqud after its letter when a word is reversed", () => {
    // ש + qamats + shin dot, ל, ו + holam, ם
    expect(toVisual("שָׁלוֹם")).toBe("ם" + "וֹ" + "ל" + "שָׁ");
  });

  it("classifies the characters a document meets", () => {
    expect(bidiType("א".codePointAt(0)!)).toBe("R");
    expect(bidiType("A".codePointAt(0)!)).toBe("L");
    expect(bidiType("5".codePointAt(0)!)).toBe("EN");
    expect(bidiType("₪".codePointAt(0)!)).toBe("ET");
    expect(bidiType("%".codePointAt(0)!)).toBe("ET");
    expect(bidiType(",".codePointAt(0)!)).toBe("CS");
    expect(bidiType("-".codePointAt(0)!)).toBe("ES");
    expect(bidiType(0x05b8)).toBe("NSM");
    expect(bidiType(0x200f)).toBe("R");
    expect(bidiType(0x2067)).toBe("BN");
  });
});

describe("line wrapping", () => {
  const chars = (text: string) => [...text].length;

  it("breaks after spaces and orders each line on its own", () => {
    expect(wrapParagraph("אחת שתיים שלוש ארבע", 10, chars).map((l) => l.text)).toEqual(["םייתש תחא", "עברא שולש"]);
  });

  it("cuts a word wider than the line, and a cut number keeps its digits' order", () => {
    expect(wrapParagraph("סכום 1234567890123", 8, chars).map((l) => l.text)).toEqual(["םוכס", "12345678", "90123"]);
  });

  it("never leaves a combining mark without its letter", () => {
    const lines = wrapParagraph("שָׁלוֹם", 1, chars).map((l) => l.text);
    for (const line of lines) expect(/^[֑-ׇ]/.test(line), line).toBe(false);
    expect(lines.join("")).toBe("שָׁ" + "ל" + "וֹ" + "ם");
  });

  it("keeps a line break as a paragraph, and an empty line as an empty line", () => {
    expect(wrapText("שורה א\n\nשורה ב\n", 100, chars).map((l) => l.text)).toEqual(["א הרוש", "", "ב הרוש"]);
  });

  it("marks the paragraph's direction for alignment", () => {
    expect(wrapParagraph("Hello world", 100, chars)[0].direction).toBe("ltr");
    expect(wrapParagraph("שלום world", 100, chars)[0].direction).toBe("rtl");
  });
});

describe("pagination", () => {
  it("fills a page and moves a piece that does not fit whole", () => {
    const pieces: Piece[] = Array.from({ length: 7 }, () => ({ height: 10 }));
    expect(paginate(pieces, 35).map((p) => [p.page, p.y])).toEqual([
      [0, 0],
      [0, 10],
      [0, 20],
      [1, 0],
      [1, 10],
      [1, 20],
      [2, 0],
    ]);
  });

  it("repeats a table's header on every page the table continues on", () => {
    const table = { id: "t", headerHeight: 5 };
    const pieces: Piece[] = [{ height: 10 }, ...Array.from({ length: 6 }, () => ({ height: 10, table }))];
    const placed = paginate(pieces, 40);
    expect(placed.map((p) => [p.page, p.y, p.headerAbove])).toEqual([
      [0, 0, false],
      [0, 15, true],
      [0, 25, false],
      [1, 5, true],
      [1, 15, false],
      [1, 25, false],
      [2, 5, true],
    ]);
  });

  it("gives the first page a shorter body (the letterhead) and drops the gap at the top of a page", () => {
    const pieces: Piece[] = [{ height: 10 }, { height: 10, gapBefore: 4 }, { height: 10, gapBefore: 4 }];
    const placed = paginate(pieces, 30, 20);
    expect(placed.map((p) => [p.page, p.y])).toEqual([
      [0, 0],
      [1, 0],
      [1, 14],
    ]);
  });

  it("keeps a title with the first line after it", () => {
    const pieces: Piece[] = [{ height: 10 }, { height: 10 }, { height: 5, keepWithNext: true }, { height: 10 }];
    expect(paginate(pieces, 30).map((p) => p.page)).toEqual([0, 0, 1, 1]);
  });

  it("cuts a row taller than a page into parts that keep every cell's lines in order", () => {
    expect(splitRowLines([7, 2, 1], 10, 4, 34)).toEqual([
      [
        [0, 3],
        [0, 2],
        [0, 1],
      ],
      [
        [3, 6],
        [2, 2],
        [1, 1],
      ],
      [
        [6, 7],
        [2, 2],
        [1, 1],
      ],
    ]);
  });
});
