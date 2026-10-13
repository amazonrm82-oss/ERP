import { describe, expect, it } from "vitest";

import { isSnoozed, MAX_SNOOZE_DAYS, snoozeSchema } from "@/features/deals/snooze";
import { addDays } from "@/lib/calendar-grid";

const today = "2026-10-13";
const parse = (value: unknown) => snoozeSchema(today).safeParse({ snoozed_until: value });

describe("postponing a deal (owner's decision, 13 October 2026)", () => {
  it("takes a real day after today, up to a year ahead", () => {
    expect(parse("2026-10-14")).toMatchObject({ success: true, data: { snoozed_until: "2026-10-14" } });
    expect(parse(addDays(today, MAX_SNOOZE_DAYS)).success).toBe(true);
  });

  it("refuses an empty, broken, past or too far day", () => {
    for (const bad of ["", null, "2026-02-30", "14.10.2026", today, "2026-10-01", addDays(today, MAX_SNOOZE_DAYS + 1)]) {
      expect(parse(bad).success, String(bad)).toBe(false);
    }
  });

  it("a deal is postponed only before its day, like report_stuck_deals", () => {
    expect(isSnoozed("2026-10-14", today)).toBe(true);
    expect(isSnoozed(today, today)).toBe(false);
    expect(isSnoozed("2026-10-01", today)).toBe(false);
    expect(isSnoozed(null, today)).toBe(false);
  });
});
