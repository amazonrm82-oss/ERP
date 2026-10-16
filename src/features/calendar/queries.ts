import "server-only";

import { getUserNames } from "@/features/shell/queries";
import type { RecordVisibility } from "@/lib/database.types";
import { must } from "@/lib/db-read";
import type { RecordType } from "@/lib/record-types";
import { createClient } from "@/lib/supabase/server";

import { HIDDEN_MEETING_STATUSES, HIDDEN_TASK_STATUSES, type TimedItem } from "./range";
import type { CalendarTeam, TeamMembership } from "./team";

export type CalendarItem = TimedItem & {
  title: string;
  // meetings: planned | held | cancelled | no_show; tasks: open | done
  status: string;
  // the meeting's type (in_person, phone…) or the task's (call, todo…)
  type: string;
  // CAL-08: the business's meeting type of a meeting; null for none and for tasks
  meetingTypeId: string | null;
  location: string | null;
  ownerName: string | null;
  // the record it is about, for a link
  related: { type: Extract<RecordType, "lead" | "contact" | "company" | "deal">; id: string } | null;
  // which of the asked-for people it belongs to (organizer, participant or task owner); empty for "everyone"
  people: string[];
  // GAP-07: blocked time (a meeting row with is_block); false for tasks
  block: boolean;
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
 * (RLS decides), for some people (CAL-04: one, a team, or the side-by-side
 * picks) or for everyone (`people` null). A meeting belongs to a person when
 * they organize it or take part in it; a task when it is assigned to them.
 * Each item says which of the people it belongs to. Cancelled tasks and tasks
 * in the recycle bin are left out. Done tasks and cancelled / no-show meetings
 * are left out too unless `showDone` (CAL-02); they are filtered in the query,
 * so CALENDAR_LIMIT counts only what is shown.
 */
export async function listCalendarItems(
  orgId: string,
  range: { from: string; to: string },
  people: string[] | null,
  showDone = false,
): Promise<{ items: CalendarItem[]; truncated: boolean }> {
  if (people && people.length === 0) return { items: [], truncated: false };
  const supabase = await createClient();

  let taskQuery = supabase
    .from("tasks")
    .select("id, title, task_type, due_at, status, owner_id, lead_id, contact_id, company_id, deal_id")
    .eq("organization_id", orgId)
    .is("deleted_at", null)
    .neq("status", "cancelled")
    .gte("due_at", range.from)
    .lt("due_at", range.to);
  if (people) taskQuery = taskQuery.in("owner_id", people);
  if (!showDone) taskQuery = taskQuery.not("status", "in", `(${HIDDEN_TASK_STATUSES.join(",")})`);

  let meetingQuery = supabase
    .from("meetings")
    .select("id, title, meeting_type, meeting_type_id, starts_at, ends_at, location, status, owner_id, lead_id, contact_id, company_id, deal_id, is_block")
    .eq("organization_id", orgId)
    .lt("starts_at", range.to)
    .gt("ends_at", range.from);
  if (!showDone) meetingQuery = meetingQuery.not("status", "in", `(${HIDDEN_MEETING_STATUSES.join(",")})`);

  const [meetingResult, taskResult] = await Promise.all([
    meetingQuery.order("starts_at").limit(CALENDAR_LIMIT + 1),
    taskQuery.order("due_at").limit(CALENDAR_LIMIT + 1),
  ]);
  const meetingRows = must(meetingResult, "calendar meetings");
  const taskRows = must(taskResult, "calendar tasks");
  const truncated = meetingRows.length > CALENDAR_LIMIT || taskRows.length > CALENDAR_LIMIT;
  let meetings = meetingRows.slice(0, CALENDAR_LIMIT);
  const tasks = taskRows.slice(0, CALENDAR_LIMIT);

  // a person's meetings: the ones they organize, and the ones they take part in
  const meetingPeople = new Map<string, Set<string>>();
  if (people && meetings.length > 0) {
    const wanted = new Set(people);
    for (const m of meetings) meetingPeople.set(m.id, new Set(m.owner_id && wanted.has(m.owner_id) ? [m.owner_id] : []));
    const ids = meetings.map((m) => m.id);
    for (let i = 0; i < ids.length; i += PARTICIPANT_CHUNK) {
      const rows = must(
        await supabase
          .from("meeting_participants")
          .select("meeting_id, user_id")
          .eq("organization_id", orgId)
          .in("user_id", people)
          .in("meeting_id", ids.slice(i, i + PARTICIPANT_CHUNK)),
        "calendar participants",
      );
      for (const row of rows) meetingPeople.get(row.meeting_id)?.add(row.user_id);
    }
    meetings = meetings.filter((m) => (meetingPeople.get(m.id)?.size ?? 0) > 0);
  }
  // in the order the people were asked for
  const ordered = (found: Set<string> | undefined) => (people && found ? people.filter((id) => found.has(id)) : []);

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
      meetingTypeId: m.meeting_type_id,
      location: m.location,
      ownerName: m.owner_id ? (names.get(m.owner_id) ?? null) : null,
      related: relatedOf(m),
      people: ordered(meetingPeople.get(m.id)),
      block: m.is_block,
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
        meetingTypeId: null,
        location: null,
        ownerName: t.owner_id ? (names.get(t.owner_id) ?? null) : null,
        related: relatedOf(t),
        people: people && t.owner_id && people.includes(t.owner_id) ? [t.owner_id] : [],
        block: false,
      })),
  ];
  items.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id));
  return { items, truncated };
}

/**
 * The organization's teams, who sits in them and the organization's record
 * visibility, for the team filter (CAL-04). Members may read all three (RLS);
 * which teams are offered is `visibleTeams()`.
 */
export async function listCalendarTeams(
  orgId: string,
): Promise<{ teams: CalendarTeam[]; memberships: TeamMembership[]; visibility: RecordVisibility }> {
  const supabase = await createClient();
  const [teamResult, memberResult, orgResult] = await Promise.all([
    supabase.from("teams").select("id, name, parent_team_id").eq("organization_id", orgId),
    supabase.from("team_members").select("team_id, user_id, is_manager").eq("organization_id", orgId),
    supabase.from("organizations").select("record_visibility").eq("id", orgId).maybeSingle(),
  ]);
  const teams = must(teamResult, "calendar teams").map((t) => ({ id: t.id, name: t.name, parentId: t.parent_team_id }));
  const memberships = must(memberResult, "calendar team members").map((m) => ({ teamId: m.team_id, userId: m.user_id, isManager: m.is_manager }));
  // no row (should not happen to a member): the narrowest choice
  const visibility = must(orgResult, "calendar visibility")?.record_visibility ?? "own";
  return { teams, memberships, visibility };
}
