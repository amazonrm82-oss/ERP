import { addDays, MONTHS, weekday, WEEKDAYS_LONG } from "@/lib/calendar-grid";
import { zoneTime } from "@/lib/format";
import { firstNameOf, MEETING_REMINDER_KIND, whatsappMessageUrl, type TemplateValues } from "@/features/whatsapp/templates";

// GAP-03: tomorrow's meetings with a one-tap WhatsApp reminder, until automatic reminders
// exist (CAL-12). Pure parts only, so they are unit tested.

/** The calendar's path for the list of tomorrow's reminders. */
export const tomorrowPath = (orgId: string) => `/o/${orgId}/calendar/tomorrow`;

/** The day after `today` ("YYYY-MM-DD" in the organization's zone). */
export function tomorrowOf(today: string): string {
  return addDays(today, 1);
}

/** "יום רביעי, 14 באוקטובר": what {תאריך} becomes in a reminder (no year: it is tomorrow). */
export function reminderDate(day: string): string {
  return `יום ${WEEKDAYS_LONG[weekday(day)]}, ${Number(day.slice(8, 10))} ב${MONTHS[Number(day.slice(5, 7)) - 1]}`;
}

/** The first template the organization marks as the meeting reminder; null when it was deleted. */
export function reminderTemplateId(templates: ReadonlyArray<{ id: string; kind: string | null }>): string | null {
  return templates.find((template) => template.kind === MEETING_REMINDER_KIND)?.id ?? null;
}

export type ReminderPerson = {
  kind: "lead" | "contact";
  id: string;
  firstName: string | null;
  fullName: string | null;
  phone: string | null;
  phoneE164: string | null;
};

/**
 * Who the reminder goes to: the meeting's contact, else its lead (the people a meeting is
 * with; a company or a deal alone names nobody). A record the user may not read, or one in the
 * recycle bin, is not in `people`, so the meeting has nobody.
 */
export function reminderPerson(
  meeting: { contactId: string | null; leadId: string | null },
  people: ReadonlyMap<string, ReminderPerson>,
): ReminderPerson | null {
  const contact = meeting.contactId ? people.get(`contact:${meeting.contactId}`) : undefined;
  if (contact) return contact;
  const lead = meeting.leadId ? people.get(`lead:${meeting.leadId}`) : undefined;
  return lead ?? null;
}

/** Why a meeting has no WhatsApp button, or null when it has one. */
export function noButtonReason(meeting: { contactId: string | null; leadId: string | null }, person: ReminderPerson | null): string | null {
  if (!person) {
    return meeting.contactId || meeting.leadId ? "אין גישה לליד או לאיש הקשר של הפגישה." : "הפגישה לא מקושרת לליד או לאיש קשר.";
  }
  if (!whatsappMessageUrl(person.phoneE164, "")) {
    return person.phone ? "מספר הטלפון לא תקין לשליחת WhatsApp." : "אין מספר טלפון.";
  }
  return null;
}

/** What the placeholders of a reminder become: the WA-01 record values plus the meeting's date and time. */
export function reminderValues(
  person: ReminderPerson,
  meeting: { startsAt: string },
  context: { user: { displayName: string }; org: { name: string; timeZone: string } },
  day: string,
): TemplateValues {
  return {
    firstName: person.firstName?.trim() || firstNameOf(person.fullName),
    fullName: person.fullName,
    userName: context.user.displayName,
    businessName: context.org.name,
    date: reminderDate(day),
    time: zoneTime(new Date(meeting.startsAt), context.org.timeZone),
  };
}
