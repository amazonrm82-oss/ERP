import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_CALENDAR_SETTINGS } from "@/features/calendar-days/holidays";
import {
  BLOCK_ROW_SHAPE,
  blockRestDays,
  blockSeriesFields,
  blockSeriesLabel,
  blockSplitText,
  releaseFollowingText,
  skippedBlockDatesText,
} from "@/features/calendar/blocks";
import { weeklySeriesTimes } from "@/features/meetings/series";

const TZ = "Asia/Jerusalem";

/**
 * GAP-07 (owner, 18 October 2026): a recurring personal block is a CAL-09 series of block rows. The pure parts: the series
 * fields sent to create_meeting_series, the texts, and the rest-day warning (a warning only, never a refusal).
 */
describe("recurring blocked time (GAP-07)", () => {
  it("sends the fixed block shape, never a record, type or reminder; an owner only when named", () => {
    const fields = blockSeriesFields("חדר כושר");
    expect(fields).toMatchObject({ title: "חדר כושר", ...BLOCK_ROW_SHAPE });
    expect(fields.reminder_minutes).toBeNull();
    for (const key of ["lead_id", "contact_id", "company_id", "deal_id", "meeting_type_id"] as const) expect(fields[key]).toBeNull();
    expect("owner_id" in fields).toBe(false);
    expect(blockSeriesFields("x", "u-1")).toMatchObject({ owner_id: "u-1", is_block: true });
  });

  it("the series fields carry only keys create_meeting_series reads", () => {
    const dir = path.join(process.cwd(), "supabase", "migrations");
    const file = readdirSync(dir).find((f) => f.endsWith("_block_series.sql"));
    if (!file) throw new Error("no migration *_block_series.sql");
    const sql = readFileSync(path.join(dir, file), "utf8");
    for (const key of Object.keys(blockSeriesFields("x", "u-1"))) expect(sql).toContain(`p_meeting ->> '${key}'`);
  });

  it("warns about each rest day the blocks fall on, once and in order", () => {
    // Fridays (a rest day by default) and Mondays
    const fridays = weeklySeriesTimes("2026-10-30", "09:00", "10:00", TZ, 3);
    expect(blockRestDays(fridays, DEFAULT_CALENDAR_SETTINGS, TZ).map((r) => r.day)).toEqual(["2026-10-30", "2026-11-06", "2026-11-13"]);
    const mondays = weeklySeriesTimes("2026-11-02", "09:00", "10:00", TZ, 4);
    expect(blockRestDays(mondays, DEFAULT_CALENDAR_SETTINGS, TZ)).toEqual([]);
    // the same day twice is named once
    expect(blockRestDays([...fridays, fridays[0]], DEFAULT_CALENDAR_SETTINGS, TZ)).toHaveLength(3);
    // a business that works on Fridays gets no warning
    expect(blockRestDays(fridays, { ...DEFAULT_CALENDAR_SETTINGS, restWeekdays: [6] }, TZ)).toEqual([]);
  });

  it("speaks of blocks, not meetings", () => {
    expect(blockSeriesLabel(3)).toBe("חסימה 3 בסדרה שבועית");
    expect(releaseFollowingText(1)).toContain("הזמן החסום הזה ישוחרר");
    expect(releaseFollowingText(4)).toContain("4 חסימות ישוחררו");
    expect(blockSplitText(5, "יום שני")).toContain("5 החסימות");
    const none = { forbidden: [], failed: [] };
    expect(skippedBlockDatesText(none, "change")).toBeNull();
    expect(skippedBlockDatesText({ ...none, forbidden: ["2026-11-09"] }, "change")).toMatch(/^חסימה אחת לא השתנתה, אין הרשאה: /);
    expect(skippedBlockDatesText({ ...none, forbidden: ["2026-11-09"] }, "release")).toMatch(/^חסימה אחת לא שוחררה, אין הרשאה: /);
    // a failed write is not a missing permission
    const failed = skippedBlockDatesText({ forbidden: ["2026-11-09"], failed: ["2026-11-16", "2026-11-23"] }, "release");
    expect(failed).toContain("אין הרשאה");
    expect(failed).toMatch(/2 חסימות לא שוחררו, שגיאה בשמירה, נסו שוב: /);
    const many = Array.from({ length: 12 }, (_, i) => `2026-12-${String(i + 1).padStart(2, "0")}`);
    expect(skippedBlockDatesText({ ...none, forbidden: many }, "change")).toMatch(/^12 חסימות לא השתנו.*; ועוד 2\.$/);
  });
});
