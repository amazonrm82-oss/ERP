import { describe, expect, it } from "vitest";

import { DEFAULT_CALENDAR_SETTINGS } from "@/features/calendar-days/holidays";
import {
  COLLECTION_REMINDER_STAGES,
  COLLECTION_REMINDER_TEXT,
  collectionReminderAt,
  collectionReminderOffset,
  collectionReminderStage,
  dueDateText,
  reminderAmountText,
} from "@/features/collection/reminders";
import { formatMoney } from "@/lib/format";
import { fillTemplate, missingPlaceholders } from "@/features/whatsapp/templates";

describe("collection reminders (COL-04)", () => {
  it("names the reminder due on a day: 3 before, the day, 7 and 14 after, each for a week at most", () => {
    expect(collectionReminderOffset("2026-11-16", "2026-11-12")).toBeNull();
    expect(collectionReminderOffset("2026-11-16", "2026-11-13")).toBe(-3);
    expect(collectionReminderOffset("2026-11-16", "2026-11-15")).toBe(-3);
    expect(collectionReminderOffset("2026-11-16", "2026-11-16")).toBe(0);
    expect(collectionReminderOffset("2026-11-16", "2026-11-22")).toBe(0);
    expect(collectionReminderOffset("2026-11-16", "2026-11-23")).toBe(7);
    expect(collectionReminderOffset("2026-11-16", "2026-11-30")).toBe(14);
    expect(collectionReminderOffset("2026-11-16", "2026-12-06")).toBe(14);
    expect(collectionReminderOffset("2026-11-16", "2026-12-07")).toBeNull();
    expect(collectionReminderOffset(null, "2026-11-16")).toBeNull();
    expect(collectionReminderOffset("16/11/2026", "2026-11-16")).toBeNull();
  });

  it("moves a reminder on a rest day to the next working day, and makes nothing on a rest day (answer (2) ב)", () => {
    // Fri+Sat off; due Monday 16 November 2026: 3 days before is Friday 13, moved to Sunday 15
    const at = (today: string) => collectionReminderAt("2026-11-16", today, DEFAULT_CALENDAR_SETTINGS);
    expect(at("2026-11-12")).toBeNull();
    expect(at("2026-11-13")).toBeNull();
    expect(at("2026-11-14")).toBeNull();
    expect(at("2026-11-15")).toEqual({ offset: -3, day: "2026-11-15" });
    expect(at("2026-11-16")).toEqual({ offset: 0, day: "2026-11-16" });
    expect(at("2026-11-20")).toBeNull();
    expect(at("2026-11-23")).toEqual({ offset: 7, day: "2026-11-23" });
    expect(at("2026-12-06")).toEqual({ offset: 14, day: "2026-11-30" });
    expect(at("2026-12-07")).toBeNull();
    // no rest days: the calendar rule
    const none = { restWeekdays: [], holidaysRest: false, holidayEvesRest: false, restOccasions: [] };
    for (let d = 0; d < 30; d++) {
      const today = new Date(Date.UTC(2026, 10, 10 + d)).toISOString().slice(0, 10);
      expect(collectionReminderAt("2026-11-16", today, none)?.offset ?? null, today).toBe(collectionReminderOffset("2026-11-16", today));
    }
  });

  it("over a long holiday: two offsets on the same day give the later one, and the window counts from the moved day", () => {
    // Sukkot 2026 with chol hamoed off: Friday 25 September to Saturday 3 October are all days off
    const sukkot = { ...DEFAULT_CALENDAR_SETTINGS, restOccasions: ["chol_hamoed_sukkot" as const] };
    const at = (today: string) => collectionReminderAt("2026-09-28", today, sukkot);
    expect(at("2026-09-24")).toBeNull();
    expect(at("2026-10-04")).toEqual({ offset: 0, day: "2026-10-04" });
    expect(at("2026-10-05")).toEqual({ offset: 7, day: "2026-10-05" });
    // due Tuesday 22 September: +7 is Tuesday 29 (chol hamoed), moved to Sunday 4 October; +14 is Tuesday 6 October
    expect(collectionReminderAt("2026-09-22", "2026-09-29", sukkot)).toBeNull();
    expect(collectionReminderAt("2026-09-22", "2026-10-04", sukkot)).toEqual({ offset: 7, day: "2026-10-04" });
    expect(collectionReminderAt("2026-09-22", "2026-10-06", sukkot)).toEqual({ offset: 14, day: "2026-10-06" });
    // due Friday 18 September: +7 (25th) and +14 (2 October) both move to 4 October: only +14 is made, until 10 October
    expect(collectionReminderAt("2026-09-18", "2026-10-04", sukkot)).toEqual({ offset: 14, day: "2026-10-04" });
    expect(collectionReminderAt("2026-09-18", "2026-10-08", sukkot)).toEqual({ offset: 14, day: "2026-10-04" });
    expect(collectionReminderAt("2026-09-18", "2026-10-11", sukkot)).toBeNull();
  });

  it("names the stage by the days from the due date", () => {
    expect(COLLECTION_REMINDER_STAGES).toEqual({
      [-3]: "בעוד 3 ימים מועד התשלום",
      0: "היום מועד התשלום",
      7: "7 ימים אחרי מועד התשלום",
      14: "14 ימים אחרי מועד התשלום",
    });
    expect(collectionReminderStage(-1)).toBe("מחר מועד התשלום");
    expect(collectionReminderStage(-2)).toBe("בעוד יומיים מועד התשלום");
    expect(collectionReminderStage(1)).toBe("יום אחרי מועד התשלום");
    expect(collectionReminderStage(8)).toBe("8 ימים אחרי מועד התשלום");
  });

  it("writes the due date as a plain day and fills the owner's text", () => {
    expect(dueDateText("2026-03-05")).toBe("5.3.2026");
    expect(dueDateText(null)).toBeNull();
    const text = fillTemplate(COLLECTION_REMINDER_TEXT, {
      firstName: "דנה",
      userName: "יוסי",
      businessName: "העסק",
      document: "חשבונית מס 1042",
      amount: "₪1,170",
      dueDate: "16.11.2026",
    });
    expect(missingPlaceholders(text)).toEqual([]);
    expect(text).toContain("חשבונית מס 1042 על סך ₪1,170");
  });

  it("quotes the amount only when the user sees all of the customer's money", () => {
    expect(reminderAmountText(117000, { allowed: true, partial: false })).toBe(formatMoney(117000));
    expect(reminderAmountText(117000, { allowed: true, partial: true })).toBeNull();
    expect(reminderAmountText(117000, { allowed: false })).toBeNull();
    expect(reminderAmountText(117000, null)).toBeNull();
    expect(reminderAmountText(0, { allowed: true, partial: false })).toBeNull();
    // the placeholder then stays for the person to complete
    expect(missingPlaceholders(fillTemplate(COLLECTION_REMINDER_TEXT, { amount: null }))).toContain("{סכום}");
  });
});
