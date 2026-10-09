import { describe, expect, it } from "vitest";

import { addDays, addMonths, longDay, monthGrid, monthTitle, shortDay, startOfWeek, weekday } from "@/lib/calendar-grid";

describe("calendar grid", () => {
  it("starts weeks on Sunday", () => {
    // 1 October 2026 is a Thursday
    expect(weekday("2026-10-01")).toBe(4);
    expect(startOfWeek("2026-10-01")).toBe("2026-09-27");
    const grid = monthGrid("2026-10-15");
    expect(grid[0][0]).toBe("2026-09-27");
    expect(grid.every((week) => week.length === 7 && weekday(week[0]) === 0)).toBe(true);
    expect(grid.flat()).toContain("2026-10-31");
    // 31 October is a Saturday: the last week ends with it
    expect(grid.at(-1)?.at(-1)).toBe("2026-10-31");
  });

  it("covers a February that fits four weeks exactly", () => {
    // February 2026 starts on Sunday and has 28 days
    const grid = monthGrid("2026-02-10");
    expect(grid).toHaveLength(4);
    expect(grid[0][0]).toBe("2026-02-01");
    expect(grid[3][6]).toBe("2026-02-28");
  });

  it("moves across months and years", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
    expect(addMonths("2026-10-09", 12)).toBe("2027-10-09");
  });

  it("names days in Hebrew", () => {
    expect(monthTitle("2026-10-09")).toBe("אוקטובר 2026");
    expect(longDay("2026-10-09")).toBe("יום שישי, 9 באוקטובר 2026");
    expect(shortDay("2026-10-09")).toBe("09.10.2026");
  });

  it("does not depend on the machine's time zone around the clock change", () => {
    // Israel moves its clocks on 25 October 2026
    expect(addDays("2026-10-24", 1)).toBe("2026-10-25");
    expect(addDays("2026-10-25", 1)).toBe("2026-10-26");
  });
});
