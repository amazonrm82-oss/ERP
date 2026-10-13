import { describe, expect, it } from "vitest";

import { noButtonReason, reminderDate, reminderPerson, reminderTemplateId, reminderValues, tomorrowOf, type ReminderPerson } from "@/features/calendar/tomorrow";
import { DEFAULT_TEMPLATES, fillTemplate, MEETING_REMINDER_KIND, missingPlaceholders } from "@/features/whatsapp/templates";

const contact: ReminderPerson = { kind: "contact", id: "c1", firstName: "דנה", fullName: "דנה כהן", phone: "050-1234567", phoneE164: "+972501234567" };
const lead: ReminderPerson = { kind: "lead", id: "l1", firstName: null, fullName: "יוסי לוי", phone: "052-7654321", phoneE164: "+972527654321" };
const people = new Map([
  ["contact:c1", contact],
  ["lead:l1", lead],
]);
const context = { user: { displayName: "רוני" }, org: { name: "סטודיו אור", timeZone: "Asia/Jerusalem" } };

describe("GAP-03 tomorrow's reminders", () => {
  it("tomorrow is the next calendar day, across months and years", () => {
    expect(tomorrowOf("2026-10-13")).toBe("2026-10-14");
    expect(tomorrowOf("2026-10-31")).toBe("2026-11-01");
    expect(tomorrowOf("2026-12-31")).toBe("2027-01-01");
  });

  it("writes the date as a weekday and a day of the month", () => {
    expect(reminderDate("2026-10-14")).toBe("יום רביעי, 14 באוקטובר");
    expect(reminderDate("2026-11-01")).toBe("יום ראשון, 1 בנובמבר");
  });

  it("picks the meeting-reminder template, and none when it was deleted", () => {
    expect(reminderTemplateId([{ id: "a", kind: null }, { id: "b", kind: MEETING_REMINDER_KIND }])).toBe("b");
    expect(reminderTemplateId([{ id: "a", kind: null }])).toBeNull();
    expect(reminderTemplateId([])).toBeNull();
  });

  it("sends to the meeting's contact first, then its lead", () => {
    expect(reminderPerson({ contactId: "c1", leadId: "l1" }, people)).toBe(contact);
    expect(reminderPerson({ contactId: null, leadId: "l1" }, people)).toBe(lead);
    // a contact the user may not read (or in the bin) is not in the map: the lead is used
    expect(reminderPerson({ contactId: "c9", leadId: "l1" }, people)).toBe(lead);
    expect(reminderPerson({ contactId: null, leadId: null }, people)).toBeNull();
  });

  it("explains a missing button", () => {
    expect(noButtonReason({ contactId: "c1", leadId: null }, contact)).toBeNull();
    expect(noButtonReason({ contactId: null, leadId: null }, null)).toBe("הפגישה לא מקושרת לליד או לאיש קשר.");
    expect(noButtonReason({ contactId: "c9", leadId: null }, null)).toBe("אין גישה לליד או לאיש הקשר של הפגישה.");
    expect(noButtonReason({ contactId: "c1", leadId: null }, { ...contact, phone: null, phoneE164: null })).toBe("אין מספר טלפון.");
    expect(noButtonReason({ contactId: "c1", leadId: null }, { ...contact, phone: "12", phoneE164: null })).toBe("מספר הטלפון לא תקין לשליחת WhatsApp.");
  });

  it("fills every placeholder of the default reminder, in the organization's zone", () => {
    const body = DEFAULT_TEMPLATES.find((t) => t.kind === MEETING_REMINDER_KIND)!.body;
    // 07:30 UTC on 14 October 2026 is 10:30 in Jerusalem (summer time until 25 October)
    const text = fillTemplate(body, reminderValues(contact, { startsAt: "2026-10-14T07:30:00.000Z" }, context, "2026-10-14"));
    expect(missingPlaceholders(text)).toEqual([]);
    expect(text).toBe("שלום דנה, תזכורת לפגישה שלנו מחר, יום רביעי, 14 באוקטובר בשעה 10:30. אם צריך לשנות, אפשר לכתוב לי כאן. רוני, סטודיו אור");
    // after the clock change: 08:00 UTC is 10:00 in winter
    const winter = reminderValues(lead, { startsAt: "2026-10-26T08:00:00.000Z" }, context, "2026-10-26");
    expect(winter).toMatchObject({ firstName: "יוסי", fullName: "יוסי לוי", time: "10:00", date: "יום שני, 26 באוקטובר" });
  });
});
