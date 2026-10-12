"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";

import { subjectSchema, SUBJECT_COLUMN, type TimelineSubject } from "@/features/activities/schema";
import { calendarPath, HIDDEN_MEETING_STATUSES } from "@/features/calendar/range";
import { revalidateLinked, type LinkedRecords } from "@/features/calendar/revalidate";
import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { TIME_ZONE } from "@/lib/app";
import type { Database, MeetingInsert } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { recordPage } from "@/lib/record-types";
import { pick } from "@/lib/validation";

import { CONFLICT_MESSAGE, type ConflictReport, type Span } from "./conflicts";
import { meetingConflicts } from "./conflicts-server";
import { MEETING_FIELD_NAMES, meetingSchema, meetingStatusSchema, meetingTimes, participantIdsSchema } from "./schema";

type Client = SupabaseClient<Database>;

/**
 * The meeting form's state. On a conflict (CAL-05) nothing is saved: the
 * report comes back with the time it is about, and the form offers to save
 * anyway (field `conflicts_ok`). A failed form also carries the participants
 * that were picked, which `values` (one value per field) cannot.
 */
export type MeetingFormState = (ActionResult & { conflicts?: ConflictReport; span?: Span; participantIds?: string[] }) | null;

/** The participants picked in the form, kept on a failed answer. */
function keepParticipants(state: MeetingFormState, formData: FormData): MeetingFormState {
  if (!state || state.ok || state.participantIds) return state;
  return { ...state, participantIds: formData.getAll("participant_ids").map(String) };
}

/** The warning state when the time clashes for someone (CAL-05), else null. */
async function conflictState(
  supabase: Client,
  orgId: string,
  check: { span: Span; userIds: string[]; excludeId?: string; timeZone: string },
  formData: FormData,
): Promise<MeetingFormState> {
  const conflicts = await meetingConflicts(supabase, orgId, check);
  if (!conflicts) return null;
  return { ok: false, message: CONFLICT_MESSAGE, values: formValues(formData), conflicts, span: check.span };
}

const PARTICIPANTS_FAILED = "הפגישה נשמרה, אבל המשתתפים לא נשמרו. פתחו את הפגישה לעריכה ובחרו אותם שוב.";

/** The record page the meeting was changed from (none from the calendar), and the calendar. */
function revalidateSubject(orgId: string, subject: TimelineSubject | null) {
  if (subject) revalidatePath(recordPage(subject.kind, orgId, subject.id));
  revalidatePath(calendarPath(orgId));
}

// the columns read back after a change, so every linked record's page is refreshed
const LINKED = "id, lead_id, contact_id, company_id, deal_id";

/** After a meeting was saved, changed or deleted: the page it was changed from, the calendar and every linked record. */
function revalidateMeeting(orgId: string, subject: TimelineSubject | null, rows: LinkedRecords[]) {
  revalidateSubject(orgId, subject);
  for (const row of rows) revalidateLinked(orgId, row);
}

// the calendar (CAL-01 follow-up) edits a meeting that has no record page: subject null
const subjectOrNone = subjectSchema.nullable();

/** The organization's time zone; null when the organization cannot be read. */
async function orgTimeZone(supabase: Client, orgId: string): Promise<string | null> {
  const { data, error } = await supabase.from("organizations").select("timezone").eq("id", orgId).maybeSingle();
  if (error || !data) {
    return null;
  }
  return data.timezone || TIME_ZONE;
}

/** The meeting fields of the form, or a field error. */
async function parseMeeting(supabase: Client, orgId: string, formData: FormData) {
  const parsed = meetingSchema.safeParse(pick(formData, MEETING_FIELD_NAMES));
  if (!parsed.success) {
    return { ok: false as const, state: invalid(parsed.error, formData) };
  }
  const participants = participantIdsSchema.safeParse(formData.getAll("participant_ids").map(String));
  if (!participants.success) {
    return { ok: false as const, state: fail(INVALID_ARGS, { values: formValues(formData) }) };
  }
  const timeZone = await orgTimeZone(supabase, orgId);
  if (!timeZone) {
    return { ok: false as const, state: fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) }) };
  }
  const data = parsed.data;
  const times = meetingTimes(data.date, data.start_time, data.end_time, timeZone);
  return {
    ok: true as const,
    participants: participants.data,
    timeZone,
    // the user saw the conflict warning and saves anyway (CAL-05)
    confirmed: formData.get("conflicts_ok") === "1",
    row: {
      title: data.title,
      meeting_type: data.meeting_type,
      ...times,
      location: data.location,
      video_url: data.video_url,
      description: data.description,
      reminder_minutes: data.reminder_minutes,
    },
  };
}

/** The id back when the user can read that contact or company (RLS decides), else null. */
async function visibleId(supabase: Client, table: "contacts" | "companies", orgId: string, id: string): Promise<string | null> {
  const { data, error } = await supabase.from(table).select("id").eq("organization_id", orgId).eq("id", id).maybeSingle();
  return !error && data ? data.id : null;
}

/**
 * Makes the meeting's participants exactly `wanted`, with the user's session:
 * RLS lets only those who may edit the meeting add or remove anyone.
 */
async function syncParticipants(supabase: Client, orgId: string, meetingId: string, wanted: string[]): Promise<boolean> {
  const { data: current, error } = await supabase
    .from("meeting_participants")
    .select("user_id")
    .eq("organization_id", orgId)
    .eq("meeting_id", meetingId);
  if (error) {
    return false;
  }
  const have = new Set(current.map((row) => row.user_id));
  const removed = [...have].filter((id) => !wanted.includes(id));
  const added = wanted.filter((id) => !have.has(id));
  if (removed.length > 0) {
    const { error: removeError } = await supabase
      .from("meeting_participants")
      .delete()
      .eq("organization_id", orgId)
      .eq("meeting_id", meetingId)
      .in("user_id", removed);
    if (removeError) {
      return false;
    }
  }
  if (added.length > 0) {
    const { error: addError } = await supabase
      .from("meeting_participants")
      .insert(added.map((userId) => ({ organization_id: orgId, meeting_id: meetingId, user_id: userId })));
    if (addError) {
      return false;
    }
  }
  return true;
}

/**
 * A new meeting on a lead, contact, company or deal (CAL-01). The organizer is
 * the user (set by the database). A meeting on a deal also carries the deal's
 * customer, so it shows on the contact's and the company's pages too.
 */
export async function createMeetingAction(orgId: string, subject: TimelineSubject | null, _prev: MeetingFormState, formData: FormData): Promise<MeetingFormState> {
  return keepParticipants(await createMeeting(orgId, subject, formData), formData);
}

async function createMeeting(orgId: string, subject: TimelineSubject | null, formData: FormData): Promise<MeetingFormState> {
  // a new meeting is set on a record: null (the calendar's edit form) is refused here
  if (!validArg(subjectSchema, subject)) {
    return fail(INVALID_ARGS);
  }
  const context = await actionContext(orgId, subject.id);
  if (!context.ok) {
    return context;
  }
  const { supabase } = context;
  const parsed = await parseMeeting(supabase, orgId, formData);
  if (!parsed.ok) {
    return parsed.state;
  }

  if (!parsed.confirmed) {
    // the organizer is the user (meetings_default_owner)
    const span = { startsAt: parsed.row.starts_at, endsAt: parsed.row.ends_at };
    const warning = await conflictState(supabase, orgId, { span, userIds: [context.user.id, ...parsed.participants], timeZone: parsed.timeZone }, formData);
    if (warning) return warning;
  }

  const row: MeetingInsert = { organization_id: orgId, ...parsed.row };
  row[SUBJECT_COLUMN[subject.kind]] = subject.id;
  if (subject.kind === "deal") {
    const { data: deal, error } = await supabase.from("deals").select("contact_id, company_id").eq("organization_id", orgId).eq("id", subject.id).maybeSingle();
    if (error) {
      return fail(dbErrorMessage(error), { values: formValues(formData) });
    }
    if (!deal) {
      return fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
    }
    // the deal's customer comes along only where the user may see it: a link to
    // a hidden record is refused by the database (meetings_check_links)
    row.contact_id = deal.contact_id ? await visibleId(supabase, "contacts", orgId, deal.contact_id) : null;
    row.company_id = deal.company_id ? await visibleId(supabase, "companies", orgId, deal.company_id) : null;
  }

  // RLS: the user can write in the organization and can see every linked record
  const { data, error } = await supabase.from("meetings").insert(row).select(LINKED).single();
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את הפגישה. נסו שוב."), { values: formValues(formData) });
  }
  const participantsSaved = await syncParticipants(supabase, orgId, data.id, parsed.participants);
  revalidateMeeting(orgId, subject, [data]);
  // the meeting itself is saved: report success (the form closes, nothing is sent twice) with the warning
  return participantsSaved ? ok() : { ok: true, message: PARTICIPANTS_FAILED };
}

/** Edit a meeting's details and participants. */
export async function updateMeetingAction(
  orgId: string,
  meetingId: string,
  subject: TimelineSubject | null,
  _prev: MeetingFormState,
  formData: FormData,
): Promise<MeetingFormState> {
  return keepParticipants(await updateMeeting(orgId, meetingId, subject, formData), formData);
}

async function updateMeeting(orgId: string, meetingId: string, subject: TimelineSubject | null, formData: FormData): Promise<MeetingFormState> {
  if (!validArg(subjectOrNone, subject)) {
    return fail(INVALID_ARGS);
  }
  const context = await actionContext(orgId, meetingId, ...(subject ? [subject.id] : []));
  if (!context.ok) {
    return context;
  }
  const { supabase } = context;
  const parsed = await parseMeeting(supabase, orgId, formData);
  if (!parsed.ok) {
    return parsed.state;
  }
  if (!parsed.confirmed) {
    const { data: current, error: readError } = await supabase
      .from("meetings")
      .select("owner_id, status")
      .eq("organization_id", orgId)
      .eq("id", meetingId)
      .maybeSingle();
    if (readError) {
      return fail(dbErrorMessage(readError), { values: formValues(formData) });
    }
    if (!current) {
      return fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
    }
    // a cancelled or no-show meeting clashes with nobody
    if (!(HIDDEN_MEETING_STATUSES as readonly string[]).includes(current.status)) {
      const span = { startsAt: parsed.row.starts_at, endsAt: parsed.row.ends_at };
      const userIds = [...(current.owner_id ? [current.owner_id] : []), ...parsed.participants];
      const warning = await conflictState(supabase, orgId, { span, userIds, excludeId: meetingId, timeZone: parsed.timeZone }, formData);
      if (warning) return warning;
    }
  }
  const { data, error } = await supabase.from("meetings").update(parsed.row).eq("organization_id", orgId).eq("id", meetingId).select(LINKED);
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את הפגישה. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  }
  const participantsSaved = await syncParticipants(supabase, orgId, meetingId, parsed.participants);
  revalidateMeeting(orgId, subject, data);
  // the meeting itself is saved: report success (the form closes, nothing is sent twice) with the warning
  return participantsSaved ? ok() : { ok: true, message: PARTICIPANTS_FAILED };
}

/** How the meeting went: status (planned, held, cancelled, no-show) and outcome. */
export async function setMeetingStatusAction(
  orgId: string,
  meetingId: string,
  subject: TimelineSubject | null,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!validArg(subjectOrNone, subject)) {
    return fail(INVALID_ARGS);
  }
  const context = await actionContext(orgId, meetingId, ...(subject ? [subject.id] : []));
  if (!context.ok) {
    return context;
  }
  const parsed = meetingStatusSchema.safeParse(pick(formData, ["status", "outcome"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { data, error } = await context.supabase
    .from("meetings")
    .update({ status: parsed.data.status, outcome: parsed.data.outcome })
    .eq("organization_id", orgId)
    .eq("id", meetingId)
    .select(LINKED);
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לעדכן את הפגישה. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  }
  revalidateMeeting(orgId, subject, data);
  return ok();
}

/** Delete a meeting set up by mistake (no recycle bin: a meeting that did not happen is cancelled). */
export async function deleteMeetingAction(orgId: string, meetingId: string, subject: TimelineSubject | null): Promise<ActionResult> {
  if (!validArg(subjectOrNone, subject)) {
    return fail(INVALID_ARGS);
  }
  const context = await actionContext(orgId, meetingId, ...(subject ? [subject.id] : []));
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase.from("meetings").delete().eq("organization_id", orgId).eq("id", meetingId).select(LINKED);
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו למחוק את הפגישה. נסו שוב."));
  }
  if (data.length === 0) {
    return fail("אי אפשר למחוק את הפגישה. רק מי שקבע אותה, מנהל הצוות של המארגן או מנהל העסק יכולים למחוק אותה. אפשר לסמן אותה כ\"בוטלה\".");
  }
  revalidateMeeting(orgId, subject, data);
  return ok();
}
