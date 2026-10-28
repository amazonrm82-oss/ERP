import { describe, expect, it } from "vitest";

import { COLLECTION_REMINDER_DRAFT_TEXT, collectionReminderOffset, dueDateText, reminderAmountText } from "@/features/collection/reminders";
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

  it("writes the due date as a plain day and fills the DRAFT text", () => {
    expect(dueDateText("2026-03-05")).toBe("5.3.2026");
    expect(dueDateText(null)).toBeNull();
    const text = fillTemplate(COLLECTION_REMINDER_DRAFT_TEXT, {
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
    expect(missingPlaceholders(fillTemplate(COLLECTION_REMINDER_DRAFT_TEXT, { amount: null }))).toContain("{סכום}");
  });
});
