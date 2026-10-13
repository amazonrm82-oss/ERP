import { describe, expect, it } from "vitest";

import { csvCell, formatCell, hourLabel } from "@/features/reports/format";
import { formatMoney, parseMoneyToAgorot } from "@/lib/format";

// Intl puts direction marks and non-breaking spaces into Hebrew currency text
const plain = (text: string) => text.replace(/[‎‏  ]/g, " ").replace(/\s+/g, " ").trim();

describe("money", () => {
  it("parses shekel amounts to agorot", () => {
    expect(parseMoneyToAgorot("1,250.50")).toBe(125050);
    expect(parseMoneyToAgorot("₪ 1,250")).toBe(125000);
    expect(parseMoneyToAgorot("0.5")).toBe(50);
    expect(parseMoneyToAgorot("0.05")).toBe(5);
    expect(parseMoneyToAgorot("")).toBe(0);
  });

  it("refuses what is not an amount", () => {
    for (const bad of ["1.234", "-5", "abc", "1e3", "12.", "99999999999999999"]) {
      expect(parseMoneyToAgorot(bad), bad).toBeNull();
    }
  });

  it("formats agorot as shekels, whole amounts without agorot", () => {
    expect(plain(formatMoney(125000))).toContain("1,250");
    expect(plain(formatMoney(125000))).not.toContain(".00");
    expect(plain(formatMoney(125050))).toContain("1,250.50");
    expect(formatMoney(null)).toBe(formatMoney(0));
  });
});

describe("report cells", () => {
  it("on screen", () => {
    expect(formatCell("number", null)).toBe("—");
    expect(formatCell("text", "")).toBe("—");
    expect(formatCell("percent", 42)).toBe("42%");
    expect(formatCell("days", 3)).toBe("3 ימים");
    expect(formatCell("minutes", 45)).toBe("45 דק'");
    expect(formatCell("minutes", 90)).toBe("1.5 שעות");
    expect(formatCell("minutes", 60 * 72)).toBe("3 ימים");
    expect(plain(formatCell("money", 990000))).toContain("9,900");
  });

  it("in a CSV file: shekels as plain numbers, text quoted and defused", () => {
    expect(csvCell("money", 125050)).toBe("1250.5");
    expect(csvCell("number", 7)).toBe("7");
    expect(csvCell("text", null)).toBe("");
    expect(csvCell("text", 'שם "מצוטט"')).toBe('"שם ""מצוטט"""');
    expect(csvCell("text", "=HYPERLINK(1)").startsWith("\"'")).toBe(true);
  });
});

describe("response time by hour (SPD-06)", () => {
  it("labels an hour of the day with its start and end", () => {
    expect(hourLabel(8)).toBe("בין 08:00 ל-09:00");
    expect(hourLabel(0)).toBe("בין 00:00 ל-01:00");
    expect(hourLabel(23)).toBe("בין 23:00 ל-00:00");
  });
});
