import "server-only";

import { getUserNames } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import type { RecordType } from "@/lib/record-types";
import { createClient } from "@/lib/supabase/server";

import type { TimedItem } from "./range";

export type CalendarItem = TimedItem & {
  title: string;
  // meetings: planned | held | cancelled | no_show; tasks: open | done
  status: string;
  // the meeting's type (in_person, phone…) or the task's (call, todo…)
  type: string;
  location: string | null;
  ownerName: string | null;
  // the record it is about, for a link
  related: { type: Extract<RecordType, "lead" | "contact" | "company" | "deal">; id: string } | null;
};

// "everyone I can see" over a month of a busy organization: past this, the screen says so
export const CALENDAR_LIMIT = 500;
const PARTICIPANT_CHUNK = 100;

type Linked = { lead_id: string | null; contact_id: string | null; company_id: string | null; deal_id: string | null };

/** The record an item is about: the deal first, then the contact, company and lead. */
function relatedOf(row: Linked): CalendarItem["related"] {
  if (row.deal_id) return { type: "deal", id: row.deal_id };
  if (row.contact_id) return { type: "contact", id: row.contact_id };
  if (row.company_id) return { type: "company", id: row.company_id };
  if (row.lead_id) return { type: "lead", id: row.lead_id };
  return null;
}

/**
 * The meetings and timed tasks between two instants that the user may see
 * (RLS decides), for one person or for everyone (`userId` null). A meeting
 * belongs to a person when they organize it or take part in it; a task when it
 * is assigned to them. Cancelled tasks and tasks in the recycle bin are left out.
 */
export async function listCalendarItems(
  orgId: string,
  range: { from: string; to: string },
  userId: string | null,
): Promise<{ items: CalendarItem[]; truncated: boolean }> {
  const supabase = await createClient();

  let taskQuery = supabase
    .from("tasks")
    .select("id, title, task_type, due_at, status, owner_id, lead_id, contact_id, company_id, deal_id")
    .eq("organization_id", orgId)
    .is("deleted_at", null)
    .neq("status", "cancelled")
    .gte("due_at", range.from)
    .lt("due_at", range.to);
  if (userId) taskQuery = taskQuery.eq("owner_id", userId);

  const [meetingResult, taskResult] = await Promise.all([
    supabase
      .from("meetings")
      .select("id, title, meeting_type, starts_at, ends_at, location, status, owner_id, lead_id, contact_id, company_id, deal_id")
      .eq("organization_id", orgId)
      .lt("starts_at", range.to)
      .gt("ends_at", range.from)
      .order("starts_at")
      .limit(CALENDAR_LIMIT + 1),
    taskQuery.order("due_at").limit(CALENDAR_LIMIT + 1),
  ]);
  const meetingRows = must(meetingResult, "calendar meetings");
  const taskRows = must(taskResult, "calendar tasks");
  const truncated = meetingRows.length > CALENDAR_LIMIT || taskRows.length > CALENDAR_LIMIT;
  let meetings = meetingRows.slice(0, CALENDAR_LIMIT);
  const tasks = taskRows.slice(0, CALENDAR_LIMIT);

  if (userId && meetings.length > 0) {
    // a person's meetings: the ones they organize, and the ones they take part in
    const taking = new Set<string>();
    const ids = meetings.filter((m) => m.owner_id !== userId).map((m) => m.id);
    for (let i = 0; i < ids.length; i += PARTICIPANT_CHUNK) {
      const rows = must(
        await supabase
          .from("meeting_participants")
          .select("meeting_id")
          .eq("organization_id", orgId)
          .eq("user_id", userId)
          .in("meeting_id", ids.slice(i, i + PARTICIPANT_CHUNK)),
        "calendar participants",
      );
      for (const row of rows) taking.add(row.meeting_id);
    }
    meetings = meetings.filter((m) => m.owner_id === userId || taking.has(m.id));
  }

  const names = await getUserNames([...meetings.map((m) => m.owner_id), ...tasks.map((t) => t.owner_id)]);
  const items: CalendarItem[] = [
    ...meetings.map((m) => ({
      id: m.id,
      kind: "meeting" as const,
      title: m.title,
      startsAt: m.starts_at,
      endsAt: m.ends_at,
      status: m.status,
      type: m.meeting_type,
      location: m.location,
      ownerName: m.owner_id ? (names.get(m.owner_id) ?? null) : null,
      related: relatedOf(m),
    })),
    ...tasks
      .filter((t): t is typeof t & { due_at: string } => t.due_at !== null)
      .map((t) => ({
        id: t.id,
        kind: "task" as const,
        title: t.title,
        startsAt: t.due_at,
        endsAt: null,
        status: t.status,
        type: t.task_type,
        location: null,
        ownerName: t.owner_id ? (names.get(t.owner_id) ?? null) : null,
        related: relatedOf(t),
      })),
  ];
  items.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id));
  return { items, truncated };
}
