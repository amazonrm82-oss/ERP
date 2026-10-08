import { describe, expect, it } from "vitest";

import { validArg, booleanArg, directionArg } from "@/lib/action-args";
import { isCalendarDate } from "@/lib/calendar-date";
import { optionalDate } from "@/lib/validation";

describe("real calendar dates (FXC-08)", () => {
  it("accepts real days, leap days included", () => {
    expect(isCalendarDate("2026-02-28")).toBe(true);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2026-12-31")).toBe(true);
  });

  it("refuses days that do not exist, which Date would roll over", () => {
    for (const bad of ["2026-02-30", "2026-02-29", "2026-04-31", "2026-13-01", "2026-00-10", "26-02-01", "2026-2-1", ""]) {
      expect(isCalendarDate(bad), bad).toBe(false);
    }
  });

  it("the form field uses the same rule", () => {
    expect(optionalDate.safeParse("2026-02-30").success).toBe(false);
    expect(optionalDate.parse("2026-02-28")).toBe("2026-02-28");
    expect(optionalDate.parse("")).toBeNull();
  });
});

describe("action arguments (FXC-08)", () => {
  it("checks shapes the types cannot", () => {
    expect(validArg(booleanArg, true)).toBe(true);
    expect(validArg(booleanArg, "true")).toBe(false);
    expect(validArg(directionArg, "up")).toBe(true);
    expect(validArg(directionArg, "sideways")).toBe(false);
  });
});
