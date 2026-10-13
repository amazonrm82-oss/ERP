import { describe, expect, it } from "vitest";

import { DEFAULT_CALENDAR_SETTINGS } from "@/features/calendar-days/holidays";
import { advanceChoices, cleanupCountText, cleanupDayOfWeek, cleanupReasons, isCleanupDay, nextOpenStage } from "@/features/pipeline-cleanup/rules";

const fmt = (n: number) => String(n);

// MNY-05: the weekly pipeline cleanup's rules
describe("pipeline cleanup (MNY-05)", () => {
  const stages = [
    { id: "c", name: "הצעה", position: 2 },
    { id: "a", name: "פנייה", position: 0 },
    { id: "b", name: "פגישה", position: 1 },
  ];

  it("advances to the next open stage by position; the last open stage has none", () => {
    expect(nextOpenStage(stages, "a")?.id).toBe("b");
    expect(nextOpenStage(stages, "b")?.id).toBe("c");
    expect(nextOpenStage(stages, "c")).toBeNull();
    expect(advanceChoices(stages, "b").map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("is offered on the business's first working day of the week", () => {
    // default rest days Friday and Saturday: Sunday 18 October 2026
    expect(cleanupDayOfWeek("2026-10-21", DEFAULT_CALENDAR_SETTINGS)).toBe("2026-10-18");
    expect(isCleanupDay("2026-10-18", DEFAULT_CALENDAR_SETTINGS)).toBe(true);
    expect(isCleanupDay("2026-10-19", DEFAULT_CALENDAR_SETTINGS)).toBe(false);
    // a business that rests on Sunday too starts on Monday
    expect(cleanupDayOfWeek("2026-10-21", { ...DEFAULT_CALENDAR_SETTINGS, restWeekdays: [0, 5, 6] })).toBe("2026-10-19");
    // Rosh Hashana's second day falls on Sunday 13 September 2026: Monday is the first working day
    expect(cleanupDayOfWeek("2026-09-15", DEFAULT_CALENDAR_SETTINGS)).toBe("2026-09-14");
  });

  it("says why a deal is on the list", () => {
    const base = { daysInStage: 20, limitDays: 14, expected: "2026-10-01", lastActivityAt: null, idleDays: 30 };
    expect(cleanupReasons({ ...base, stuck: true, overdue: false }, fmt)).toEqual(["20 ימים בשלב (מעל 14)", "אין פעילות"]);
    const both = cleanupReasons({ ...base, stuck: true, overdue: true }, fmt);
    expect(both).toHaveLength(3);
    expect(both[1]).toMatch(/^תאריך הסגירה עבר: /);
    expect(cleanupReasons({ ...base, stuck: false, overdue: true, lastActivityAt: "2026-10-10T10:00:00Z", idleDays: 3 }, fmt)[1]).toBe("פעילות אחרונה לפני 3 ימים");
  });

  it("counts in words", () => {
    expect(cleanupCountText(1, fmt)).toBe("עסקה אחת מחכה להחלטה");
    expect(cleanupCountText(4, fmt)).toBe("4 עסקאות מחכות להחלטה");
  });
});
