import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { COLLECTION_PAUSED_LINE, madeWhilePaused, NOT_PAUSED, pauseBannerText, pauseFromRow, pauseSchema, pauseTimeText, PAUSE_REASON_MAX } from "@/features/sending-pause/pause";

// HEB-09: found by its suffix (the lead renumbers migrations at merge)
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = readdirSync(dir).find((name) => name.endsWith("_customer_sending_pause.sql"));
const sql = readFileSync(new URL(file ?? "missing", dir), "utf8");

describe("sending pause (HEB-09)", () => {
  it("the reason limit equals the database's", () => {
    expect(sql).toContain(`char_length(reason) between 1 and ${PAUSE_REASON_MAX}`);
  });

  it("a pause needs a reason, trimmed, within the limit", () => {
    expect(pauseSchema.safeParse({ reason: "  יום אבל \r\n" }).data?.reason).toBe("יום אבל");
    expect(pauseSchema.safeParse({ reason: "   " }).success).toBe(false);
    expect(pauseSchema.safeParse({}).success).toBe(false);
    expect(pauseSchema.safeParse({ reason: "א".repeat(PAUSE_REASON_MAX) }).success).toBe(true);
    expect(pauseSchema.safeParse({ reason: "א".repeat(PAUSE_REASON_MAX + 1) }).success).toBe(false);
  });

  it("no row is not paused, and the banner shows only while paused", () => {
    expect(pauseFromRow(null)).toEqual(NOT_PAUSED);
    expect(pauseBannerText(NOT_PAUSED, null)).toBeNull();
    const pause = pauseFromRow({ paused: true, reason: "יום אבל", paused_at: "2026-11-02T08:00:00Z", paused_by: null, resumed_at: null, resumed_by: null });
    expect(pauseBannerText(pause, "2.11.2026, 10:00")).toBe("השליחה האוטומטית ללקוחות מושהית מאז 2.11.2026, 10:00 (יום אבל). הודעות לצוות ממשיכות כרגיל.");
    const resumed = pauseFromRow({ paused: false, reason: null, paused_at: "2026-11-02T08:00:00Z", paused_by: null, resumed_at: "2026-11-03T08:00:00Z", resumed_by: null });
    expect(pauseBannerText(resumed, "x")).toBeNull();
  });

  it("times show in the business's zone (review L-3)", () => {
    const at = "2026-11-02T22:30:00Z";
    expect(pauseTimeText(at, "Asia/Jerusalem")).toMatch(/3 .*0:30/);
    expect(pauseTimeText(at, "America/New_York")).toMatch(/2 .*17:30/);
    expect(pauseTimeText(null, "Asia/Jerusalem")).toBe("");
    expect(pauseTimeText(at, "Not/AZone")).not.toBe("");
  });

  it("owner's answer (45): the collection task's line equals the migration's, and marks only such a task", () => {
    const line = readFileSync(new URL(readdirSync(dir).find((name) => name.endsWith("_collection_reminder_paused_line.sql")) ?? "missing", dir), "utf8");
    expect(line).toContain(`then '${COLLECTION_PAUSED_LINE}' end`);
    expect(madeWhilePaused(COLLECTION_PAUSED_LINE)).toBe(true);
    expect(madeWhilePaused(null)).toBe(false);
    expect(madeWhilePaused("הערה אחרת")).toBe(false);
  });
});

