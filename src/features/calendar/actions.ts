"use server";

import { revalidatePath } from "next/cache";

import type { TimelineSubject } from "@/features/activities/schema";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { TIME_ZONE } from "@/lib/app";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { zonedIso } from "@/lib/format";
import { paths } from "@/lib/paths";

import { CONFLICT_MESSAGE, type ConflictReport, type Span } from "@/features/meetings/conflicts";
import { meetingConflicts } from "@/features/meetings/conflicts-server";

import { HIDDEN_MEETING_STATUSES, movedEnd } from "./range";
import { revalidateLinked, type LinkedRecords } from "./revalidate";
import { moveTargetSchema, type MoveTarget } from "./schema";

/** A move's answer; on a conflict (CAL-05) nothing moved and the report says why. */
export type MoveResult = ActionResult & { conflicts?: ConflictReport; span?: Span };

type Linked = LinkedRecords;

/**
 * Move a meeting or a task on the calendar (CAL-02), by dragging or with the
 * "move" form: a meeting starts at the new day and time and keeps its length;
 * a task is due then, and its reminder keeps the same lead time. The time is
 * read in the organization's zone. Everything runs with the user's session:
 * RLS decides who may move what (0 rows back = not permitted or gone).
 */
export async function moveCalendarItemAction(orgId: string, itemId: string, target: MoveTarget): Promise<MoveResult> {
  if (!validArg(moveTargetSchema, target)) {
    return fail(INVALID_ARGS);
  }
  const context = await actionContext(orgId, itemId);
  if (!context.ok) {
    return context;
  }
  const { supabase } = context;

  const { data: org, error: orgError } = await supabase.from("organizations").select("timezone").eq("id", orgId).maybeSingle();
  if (orgError) {
    return fail(dbErrorMessage(orgError));
  }
  if (!org) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  const timeZone = org.timezone || TIME_ZONE;
  const start = zonedIso(target.date, `${target.time}:00`, timeZone);

  if (target.kind === "meeting") {
    const { data: meeting, error: readError } = await supabase
      .from("meetings")
      .select("starts_at, ends_at, status, owner_id, lead_id, contact_id, company_id, deal_id")
      .eq("organization_id", orgId)
      .eq("id", itemId)
      .maybeSingle();
    if (readError) {
      return fail(dbErrorMessage(readError));
    }
    if (!meeting) {
      return fail(NOT_FOUND_OR_FORBIDDEN);
    }
    const span = { startsAt: start, endsAt: movedEnd(meeting.starts_at, meeting.ends_at, start) };
    // CAL-05: warn before a meeting moves onto someone's other meeting or off their hours
    if (!target.confirmed && !(HIDDEN_MEETING_STATUSES as readonly string[]).includes(meeting.status)) {
      const { data: participants, error: participantsError } = await supabase
        .from("meeting_participants")
        .select("user_id")
        .eq("organization_id", orgId)
        .eq("meeting_id", itemId);
      if (participantsError) {
        return fail(dbErrorMessage(participantsError));
      }
      const userIds = [...(meeting.owner_id ? [meeting.owner_id] : []), ...participants.map((p) => p.user_id)];
      const conflicts = await meetingConflicts(supabase, orgId, { span, userIds, excludeId: itemId, timeZone });
      if (conflicts) {
        return { ok: false, message: CONFLICT_MESSAGE, conflicts, span };
      }
    }
    const { data, error } = await supabase
      .from("meetings")
      .update({ starts_at: span.startsAt, ends_at: span.endsAt })
      .eq("organization_id", orgId)
      .eq("id", itemId)
      .select("id");
    if (error) {
      return fail(dbErrorMessage(error, "לא הצלחנו להעביר את הפגישה. נסו שוב."));
    }
    if (data.length === 0) {
      return fail(NOT_FOUND_OR_FORBIDDEN);
    }
    revalidateLinked(orgId, meeting);
    return ok();
  }

  const { data: task, error: readError } = await supabase
    .from("tasks")
    .select("due_at, remind_at, lead_id, contact_id, company_id, deal_id")
    .eq("organization_id", orgId)
    .eq("id", itemId)
    .is("deleted_at", null)
    .maybeSingle();
  if (readError) {
    return fail(dbErrorMessage(readError));
  }
  if (!task) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  // the reminder keeps the same time before the due time (as when a task is put off)
  const remind = task.due_at && task.remind_at ? movedEnd(task.due_at, task.remind_at, start) : null;
  const { data, error } = await supabase
    .from("tasks")
    .update({ due_at: start, remind_at: remind })
    .eq("organization_id", orgId)
    .eq("id", itemId)
    .is("deleted_at", null)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו להעביר את המשימה. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateLinked(orgId, task);
  revalidatePath(paths.tasks(orgId));
  revalidatePath(paths.org(orgId));
  return ok();
}

/** A meeting as the calendar's window shows it (CAL-01 follow-up): what the record cards show, plus its record. */
export type MeetingDetails = {
  id: string;
  title: string;
  meetingType: string;
  startsAt: string;
  endsAt: string;
  location: string | null;
  videoUrl: string | null;
  description: string | null;
  status: string;
  outcome: string | null;
  // CAL-06: minutes before the start; null = no reminder
  reminderMinutes: number | null;
  participants: { userId: string; name: string }[];
  // the record it is on, for refreshing that record's page after a change; null = an internal meeting
  subject: TimelineSubject | null;
};

/**
 * The details of one meeting for the calendar's window, read with the user's
 * session: a meeting the user may not read (RLS) answers "not found", so its
 * details and buttons never show.
 */
export async function meetingDetailsAction(orgId: string, meetingId: string): Promise<ActionResult & { meeting?: MeetingDetails }> {
  const context = await actionContext(orgId, meetingId);
  if (!context.ok) {
    return context;
  }
  const { supabase } = context;
  const { data: row, error } = await supabase
    .from("meetings")
    .select("id, title, meeting_type, starts_at, ends_at, location, video_url, description, status, outcome, reminder_minutes, lead_id, contact_id, company_id, deal_id")
    .eq("organization_id", orgId)
    .eq("id", meetingId)
    .maybeSingle();
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (!row) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  const { data: participants, error: participantsError } = await supabase
    .from("meeting_participants")
    .select("user_id")
    .eq("organization_id", orgId)
    .eq("meeting_id", meetingId);
  if (participantsError) {
    return fail(dbErrorMessage(participantsError));
  }
  const ids = participants.map((p) => p.user_id);
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { data: profiles, error: profilesError } = await supabase.from("profiles").select("id, full_name, email").in("id", ids);
    if (profilesError) {
      return fail(dbErrorMessage(profilesError));
    }
    for (const p of profiles) names.set(p.id, p.full_name?.trim() || p.email || "משתמש");
  }
  return {
    ok: true,
    meeting: {
      id: row.id,
      title: row.title,
      meetingType: row.meeting_type,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      location: row.location,
      videoUrl: row.video_url,
      description: row.description,
      status: row.status,
      outcome: row.outcome,
      reminderMinutes: row.reminder_minutes,
      participants: ids.map((id) => ({ userId: id, name: names.get(id) ?? "משתמש" })),
      subject: subjectOf(row),
    },
  };
}

/** The record a meeting is on, as the record pages see it: the deal first, then the contact, company and lead. */
function subjectOf(row: Linked): TimelineSubject | null {
  if (row.deal_id) return { kind: "deal", id: row.deal_id };
  if (row.contact_id) return { kind: "contact", id: row.contact_id };
  if (row.company_id) return { kind: "company", id: row.company_id };
  if (row.lead_id) return { kind: "lead", id: row.lead_id };
  return null;
}
