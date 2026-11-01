import { describe, expect, it } from "vitest";

import { DEFAULT_CALENDAR_SETTINGS, type CalendarSettings } from "@/features/calendar-days/holidays";
import { VALIDITY_CHOICES, validityDay, validityStart } from "@/features/quotes/validity";

// HEB-03: the quick choices next to a draft quote's "valid until" date.
const NO_HOLIDAYS: CalendarSettings = { ...DEFAULT_CALENDAR_SETTINGS, holidaysRest: false };
const choice = (key: string) => {
  const found = VALIDITY_CHOICES.find((c) => c.key === key);
  if (!found) throw new Error(key);
  return found;
};

describe("quote validity shortcuts", () => {
  it("offers 7 and 14 business days and 30 calendar days, each with a label that holds its visible text", () => {
    expect(VALIDITY_CHOICES.map((c) => [c.days, c.unit])).toEqual([
      [7, "business"],
      [14, "business"],
      [30, "calendar"],
    ]);
    for (const c of VALIDITY_CHOICES) expect(c.ariaLabel).toContain(c.label);
  });

  it("counts business days after the quote date, skipping the weekend (Friday and Saturday by default)", () => {
    // Thursday 15 October 2026
    expect(validityDay(DEFAULT_CALENDAR_SETTINGS, "2026-10-15", choice("b7"))).toEqual({ day: "2026-10-26", moved: false });
    expect(validityDay(DEFAULT_CALENDAR_SETTINGS, "2026-10-15", choice("b14"))).toEqual({ day: "2026-11-04", moved: false });
    // the business's own rest days: a business that works on Friday
    const sixDays: CalendarSettings = { ...DEFAULT_CALENDAR_SETTINGS, restWeekdays: [6] };
    expect(validityDay(sixDays, "2026-10-15", choice("b7"))).toEqual({ day: "2026-10-23", moved: false });
  });

  it("skips a holiday that is a rest day of the business (Yom Kippur, Monday 21 September 2026)", () => {
    expect(validityDay(DEFAULT_CALENDAR_SETTINGS, "2026-09-17", choice("b7"))).toEqual({ day: "2026-09-29", moved: false });
    expect(validityDay(NO_HOLIDAYS, "2026-09-17", choice("b7"))).toEqual({ day: "2026-09-28", moved: false });
  });

  it("counts plain days for 30 days and moves a rest day to the next working day", () => {
    // 30 days after Monday 12 October = Wednesday 11 November: a working day
    expect(validityDay(DEFAULT_CALENDAR_SETTINGS, "2026-10-12", choice("c30"))).toEqual({ day: "2026-11-11", moved: false });
    // 30 days after Thursday 15 October = Saturday 14 November -> Sunday 15 November
    expect(validityDay(DEFAULT_CALENDAR_SETTINGS, "2026-10-15", choice("c30"))).toEqual({ day: "2026-11-15", moved: true });
    // 30 days after 22 August = Yom Kippur -> Tuesday 22 September; without holidays it stays
    expect(validityDay(DEFAULT_CALENDAR_SETTINGS, "2026-08-22", choice("c30"))).toEqual({ day: "2026-09-22", moved: true });
    expect(validityDay(NO_HOLIDAYS, "2026-08-22", choice("c30"))).toEqual({ day: "2026-09-21", moved: false });
  });

  it("counts from the quote's date, else today; a bad start gives nothing", () => {
    expect(validityStart("2026-10-15", "2026-11-01")).toBe("2026-10-15");
    expect(validityStart(null, "2026-11-01")).toBe("2026-11-01");
    expect(validityStart("", "2026-11-01")).toBe("2026-11-01");
    expect(validityDay(DEFAULT_CALENDAR_SETTINGS, "15.10.2026", choice("b7"))).toBeNull();
  });
});
