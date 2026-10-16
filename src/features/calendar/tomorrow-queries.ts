import "server-only";

import { listWhatsappTemplates } from "@/features/whatsapp/queries";
import { must } from "@/lib/db-read";
import { zonedIso } from "@/lib/format";
import { readAllPages } from "@/lib/paged-read";
import { createClient } from "@/lib/supabase/server";

import { listCalendarItems, type CalendarItem } from "./queries";
import { rangeBounds } from "./range";
import { reminderPerson, reminderTemplateId, type ReminderPerson } from "./tomorrow";

const CHUNK = 100;

export type TomorrowMeeting = Pick<CalendarItem, "id" | "title" | "startsAt" | "type" | "location" | "related"> & {
  endsAt: string;
  contactId: string | null;
  leadId: string | null;
  person: ReminderPerson | null;
  // a WhatsApp message was logged on the person's record today (by anyone)
  messagedToday: boolean;
};

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/**
 * GAP-03: the meetings of `tomorrow` (a day in the organization's zone) that the user organizes
 * or takes part in, through the calendar's own read (RLS decides; cancelled and no-show meetings
 * are left out), with the lead or contact each one is with, and the id of the organization's
 * meeting-reminder template (null when it was deleted). Everything is read with the user's
 * session: a lead or contact the user may not read, or one in the recycle bin, is not offered.
 */
export async function listTomorrowMeetings(
  orgId: string,
  userId: string,
  tomorrow: string,
  today: string,
  timeZone: string,
): Promise<{ meetings: TomorrowMeeting[]; truncated: boolean; templateId: string | null }> {
  const bounds = rangeBounds([tomorrow], timeZone);
  const [calendar, templates] = await Promise.all([listCalendarItems(orgId, bounds, [userId]), listWhatsappTemplates(orgId)]);
  // a meeting that only runs into tomorrow started earlier: it is not tomorrow's
  const items = calendar.items.filter(
    (item): item is CalendarItem & { endsAt: string } =>
      item.kind === "meeting" && !item.block && item.endsAt !== null && Date.parse(item.startsAt) >= Date.parse(bounds.from),
  );
  const templateId = reminderTemplateId(templates);
  if (items.length === 0) return { meetings: [], truncated: calendar.truncated, templateId };

  const supabase = await createClient();
  const links = new Map<string, { lead_id: string | null; contact_id: string | null }>();
  for (const ids of chunks(items.map((item) => item.id))) {
    const rows = must(
      await supabase.from("meetings").select("id, lead_id, contact_id").eq("organization_id", orgId).in("id", ids),
      "tomorrow meeting links",
    );
    for (const row of rows) links.set(row.id, { lead_id: row.lead_id, contact_id: row.contact_id });
  }

  const contactIds = [...new Set([...links.values()].map((link) => link.contact_id).filter((id): id is string => id !== null))];
  const leadIds = [...new Set([...links.values()].map((link) => link.lead_id).filter((id): id is string => id !== null))];
  const people = new Map<string, ReminderPerson>();
  for (const ids of chunks(contactIds)) {
    const rows = must(
      await supabase
        .from("contacts")
        .select("id, first_name, full_name, phone, phone_e164")
        .eq("organization_id", orgId)
        .is("deleted_at", null)
        .in("id", ids),
      "tomorrow contacts",
    );
    for (const row of rows) {
      people.set(`contact:${row.id}`, { kind: "contact", id: row.id, firstName: row.first_name, fullName: row.full_name, phone: row.phone, phoneE164: row.phone_e164 });
    }
  }
  for (const ids of chunks(leadIds)) {
    const rows = must(
      await supabase.from("leads").select("id, full_name, phone, phone_e164").eq("organization_id", orgId).is("deleted_at", null).in("id", ids),
      "tomorrow leads",
    );
    for (const row of rows) {
      people.set(`lead:${row.id}`, { kind: "lead", id: row.id, firstName: null, fullName: row.full_name, phone: row.phone, phoneE164: row.phone_e164 });
    }
  }

  const meetings = items.map((item) => {
    const link = links.get(item.id) ?? { lead_id: null, contact_id: null };
    const meeting = { contactId: link.contact_id, leadId: link.lead_id };
    return {
      id: item.id,
      title: item.title,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      type: item.type,
      location: item.location,
      related: item.related,
      ...meeting,
      person: reminderPerson(meeting, people),
      messagedToday: false,
    };
  });

  // which of the people already got a WhatsApp message logged today (in the organization's zone)
  const since = zonedIso(today, "00:00", timeZone);
  const messaged = new Set<string>();
  for (const kind of ["contact", "lead"] as const) {
    const ids = [...new Set(meetings.map((m) => (m.person?.kind === kind ? m.person.id : null)).filter((id): id is string => id !== null))];
    const column = kind === "contact" ? "contact_id" : "lead_id";
    for (const part of chunks(ids)) {
      const { rows } = await readAllPages(async (from, to) =>
        must(
          await supabase
            .from("activities")
            .select("id, lead_id, contact_id")
            .eq("organization_id", orgId)
            .eq("type", "whatsapp")
            .gte("created_at", since)
            .in(column, part)
            .order("id")
            .range(from, to),
          "tomorrow messages",
        ),
      );
      for (const row of rows) {
        const id = row[column];
        if (id) messaged.add(`${kind}:${id}`);
      }
    }
  }
  for (const meeting of meetings) {
    if (meeting.person) meeting.messagedToday = messaged.has(`${meeting.person.kind}:${meeting.person.id}`);
  }
  return { meetings, truncated: calendar.truncated, templateId };
}
