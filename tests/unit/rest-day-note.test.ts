import { describe, expect, it } from "vitest";

import { nextWorkingDay } from "@/features/calendar-days/business-days";
import { DEFAULT_CALENDAR_SETTINGS } from "@/features/calendar-days/holidays";
import { movedToWorkingDayNotice, restDayNote } from "@/features/calendar-days/rest-day-note";
import { BUSINESS_CALENDAR_EFFECTS } from "@/features/calendar-days/components/business-calendar-effects";

// HEB-02: a due date on a day the business does not work gets a warning and the next working day
describe("restDayNote", () => {
  it("is null on a working day or for a value that is not a date", () => {
    expect(restDayNote("2026-10-15", DEFAULT_CALENDAR_SETTINGS)).toBeNull();
    expect(restDayNote("", DEFAULT_CALENDAR_SETTINGS)).toBeNull();
    expect(restDayNote("2026-02-30", DEFAULT_CALENDAR_SETTINGS)).toBeNull();
  });

  it("names a weekly rest day and offers the next working day", () => {
    // Friday 16.10.2026 -> Sunday 18.10
    expect(restDayNote("2026-10-16", DEFAULT_CALENDAR_SETTINGS)).toEqual({
      text: "יום שישי הוא יום מנוחה של העסק.",
      next: "2026-10-18",
      moveLabel: "העברה ליום ראשון, 18 באוקטובר 2026",
    });
  });

  it("names a holiday the business closes on, and nothing when it works on it", () => {
    // Yom Kippur, Monday 21.9.2026
    const note = restDayNote("2026-09-21", DEFAULT_CALENDAR_SETTINGS);
    expect(note?.text).toBe("יום כיפור: העסק לא עובד ביום הזה.");
    expect(note?.next).toBe("2026-09-22");
    expect(restDayNote("2026-09-21", { ...DEFAULT_CALENDAR_SETTINGS, holidaysRest: false })).toBeNull();
  });
});

describe("nextWorkingDay", () => {
  it("keeps a working day and moves a rest day forward", () => {
    expect(nextWorkingDay(DEFAULT_CALENDAR_SETTINGS, "2026-10-15")).toBe("2026-10-15");
    expect(nextWorkingDay(DEFAULT_CALENDAR_SETTINGS, "2026-10-17")).toBe("2026-10-18");
    expect(nextWorkingDay({ restWeekdays: [], holidaysRest: false, holidayEvesRest: false, restOccasions: [] }, "2026-10-17")).toBe("2026-10-17");
  });

  it("leaves a value that is not a date as it is", () => {
    expect(nextWorkingDay(DEFAULT_CALENDAR_SETTINGS, "x")).toBe("x");
  });
});

describe("what the business calendar affects", () => {
  it("is a short Hebrew list", () => {
    expect(BUSINESS_CALENDAR_EFFECTS.length).toBeGreaterThan(3);
    for (const line of BUSINESS_CALENDAR_EFFECTS) expect(line).toMatch(/[א-ת]/);
  });
});

describe("movedToWorkingDayNotice", () => {
  it("names the weekday and the date, in the owner's wording", () => {
    expect(movedToWorkingDayNotice("2026-10-18")).toBe("נקבע ליום ראשון, 18 באוקטובר (יום העבודה הבא)");
    expect(movedToWorkingDayNotice("2027-01-03")).toBe("נקבע ליום ראשון, 3 בינואר (יום העבודה הבא)");
    // the day is the one nextWorkingDay() gives (Saturday 17.10.2026 -> Sunday 18.10)
    expect(movedToWorkingDayNotice(nextWorkingDay(DEFAULT_CALENDAR_SETTINGS, "2026-10-17"))).toBe("נקבע ליום ראשון, 18 באוקטובר (יום העבודה הבא)");
  });
});
