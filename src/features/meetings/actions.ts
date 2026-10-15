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
import { meetingConflicts, seriesConflicts } from "./conflicts-server";
import { MEETING_FIELD_NAMES, meetingSchema, meetingStatusSchema, meetingTimes, participantIdsSchema } from "./schema";
import {
  movedByHand,
  movesDay,
  seriesCountSchema,
  seriesScopeSchema,
  shiftToTimes,
  splitStartDate,
  deleteFollowingText,
  fromHereNotPast,
  skippedDatesText,
  splitWarningText,
  weeklySeriesTimes,
  type SeriesSpan,
} from "./series";
import { longDay } from "@/lib/calendar-grid";
import { zoneDate } from "@/lib/format";

type Client = SupabaseClient<Database>;

/**
 * The meeting form's state. On a conflict (CAL-05) nothing is saved: the
 * report comes back with the time it is about, and the form offers to save
 * anyway (field `conflicts_ok`). A failed form also carries the participants
 * that were picked, which `values` (one value per field) cannot.
 */
export type MeetingFormState =
  | (ActionResult & {
      conflicts?: ConflictReport;
      span?: Span;
      participantIds?: string[];
      // CAL-09: moving a series to another weekday asks first (field `split_ok`)
      split?: { text: string };
    })
  | null;

/** The participants picked in the form, kept on a failed answer. */
function keepParticipants(state: MeetingFormState, formData: FormData): MeetingFormState {
  if (!state || state.ok || state.participantIds) return state;
  return { ...state, participantIds: formData.getAll("participant_ids").map(String) };
}

/** The warning state when the time clashes for someone (CAL-05), else null. */
async function conflictState(
  supabase: Client,
  orgId: string,
  check: { span: Span; userIds: string[]; excludeId?: string; timeZone: string; typeId?: string | null },
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
    // the form's own date and wall-clock times (CAL-09 builds the series from them)
    form: { date: data.date, start_time: data.start_time, end_time: data.end_time },
    row: {
      title: data.title,
      meeting_type_id: data.meeting_type_id,
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

  // CAL-09: "פגישה חוזרת כל שבוע, X פעמים"
  let series: SeriesSpan[] | null = null;
  if (formData.get("repeat") === "weekly") {
    const count = seriesCountSchema.safeParse(formData.get("series_count"));
    if (!count.success) {
      return fail(count.error.issues[0]?.message ?? INVALID_ARGS, {
        values: formValues(formData),
        fieldErrors: { series_count: count.error.issues[0]?.message ?? INVALID_ARGS },
      });
    }
    series = weeklySeriesTimes(parsed.form.date, parsed.form.start_time, parsed.form.end_time, parsed.timeZone, count.data);
  }

  if (!parsed.confirmed) {
    // the organizer is the user (meetings_default_owner)
    const userIds = [context.user.id, ...parsed.participants];
    if (series) {
      // CAL-09: every week of the series is checked, in one warning
      const spans = series.map((t) => ({ span: { startsAt: t.starts_at, endsAt: t.ends_at } }));
      const conflicts = await seriesConflicts(supabase, orgId, { spans, userIds, timeZone: parsed.timeZone, typeId: parsed.row.meeting_type_id });
      if (conflicts) return { ok: false, message: CONFLICT_MESSAGE, values: formValues(formData), conflicts, span: spans[0].span };
    } else {
      const span = { startsAt: parsed.row.starts_at, endsAt: parsed.row.ends_at };
      const warning = await conflictState(supabase, orgId, { span, userIds, timeZone: parsed.timeZone, typeId: parsed.row.meeting_type_id }, formData);
      if (warning) return warning;
    }
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

  if (series) {
    // CAL-09: all the meetings and their participants in one transaction (security invoker: RLS and
    // every meetings trigger judge each one)
    const fields = {
      title: row.title,
      meeting_type: row.meeting_type,
      meeting_type_id: row.meeting_type_id ?? null,
      location: row.location ?? null,
      video_url: row.video_url ?? null,
      description: row.description ?? null,
      reminder_minutes: row.reminder_minutes ?? null,
      lead_id: row.lead_id ?? null,
      contact_id: row.contact_id ?? null,
      company_id: row.company_id ?? null,
      deal_id: row.deal_id ?? null,
    };
    const { error } = await supabase.rpc("create_meeting_series", {
      p_org: orgId,
      p_meeting: fields,
      p_times: series,
      p_participants: parsed.participants,
    });
    if (error) {
      return fail(dbErrorMessage(error, "לא הצלחנו לקבוע את הסדרה. נסו שוב."), { values: formValues(formData) });
    }
    revalidateMeeting(orgId, subject, [{ lead_id: row.lead_id ?? null, contact_id: row.contact_id ?? null, company_id: row.company_id ?? null, deal_id: row.deal_id ?? null }]);
    return ok();
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
  const { data: current, error: readError } = await supabase
    .from("meetings")
    .select("owner_id, status, starts_at, series_id, series_index, lead_id, contact_id, company_id, deal_id")
    .eq("organization_id", orgId)
    .eq("id", meetingId)
    .maybeSingle();
  if (readError) {
    return fail(dbErrorMessage(readError), { values: formValues(formData) });
  }
  if (!current) {
    return fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  }

  // CAL-09: "this and following" of a series: the same details, and the new time of day on each
  // following meeting's own date; only meetings still planned follow (held or cancelled ones stay)
  const following =
    seriesScopeSchema.parse(formData.get("series_scope")) === "following" && current.series_id !== null && current.series_index !== null
      ? await followingMeetings(supabase, orgId, current.series_id, current.series_index)
      : null;
  if (following && "error" in following) {
    return fail(following.error, { values: formValues(formData) });
  }
  if (following && movesDay(current.starts_at, parsed.form.date, parsed.timeZone) && following.rows.length > 0) {
    // CAL-09 (owner, 15 October 2026): another weekday splits the series
    return splitSeries(context, orgId, meetingId, subject, { ...current, series_id: current.series_id!, series_index: current.series_index! }, following.rows, parsed, formData);
  }
  const followingSpans = (following?.rows ?? []).map((row) => ({
    id: row.id,
    day: zoneDate(new Date(row.starts_at), parsed.timeZone),
    times: shiftToTimes(row.starts_at, parsed.form.start_time, parsed.form.end_time, parsed.timeZone),
  }));

  if (!parsed.confirmed && !(HIDDEN_MEETING_STATUSES as readonly string[]).includes(current.status)) {
    // a cancelled or no-show meeting clashes with nobody
    const userIds = [...(current.owner_id ? [current.owner_id] : []), ...parsed.participants];
    if (followingSpans.length > 0) {
      const spans = [
        { span: { startsAt: parsed.row.starts_at, endsAt: parsed.row.ends_at }, excludeId: meetingId },
        ...followingSpans.map((f) => ({ span: { startsAt: f.times.starts_at, endsAt: f.times.ends_at }, excludeId: f.id })),
      ];
      const conflicts = await seriesConflicts(supabase, orgId, { spans, userIds, timeZone: parsed.timeZone, typeId: parsed.row.meeting_type_id });
      if (conflicts) return { ok: false, message: CONFLICT_MESSAGE, values: formValues(formData), conflicts, span: spans[0].span };
    } else {
      const span = { startsAt: parsed.row.starts_at, endsAt: parsed.row.ends_at };
      const warning = await conflictState(supabase, orgId, { span, userIds, excludeId: meetingId, timeZone: parsed.timeZone, typeId: parsed.row.meeting_type_id }, formData);
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
  let participantsSaved = await syncParticipants(supabase, orgId, meetingId, parsed.participants);

  // the following meetings, one by one with the user's session: RLS decides each (0 rows = not permitted)
  const skipped: string[] = [];
  for (const next of followingSpans) {
    const { data: rows, error: nextError } = await supabase
      .from("meetings")
      .update({ ...parsed.row, ...next.times })
      .eq("organization_id", orgId)
      .eq("id", next.id)
      .select(LINKED);
    if (nextError || rows.length === 0) {
      skipped.push(next.day);
      continue;
    }
    data.push(...rows);
    participantsSaved = (await syncParticipants(supabase, orgId, next.id, parsed.participants)) && participantsSaved;
  }
  revalidateMeeting(orgId, subject, data);
  // the meeting itself is saved: report success (the form closes, nothing is sent twice) with the warning
  if (skipped.length > 0) return { ok: true, message: `הפגישה נשמרה. ${skippedDatesText(skipped)}` };
  return participantsSaved ? ok() : { ok: true, message: PARTICIPANTS_FAILED };
}

/** The planned meetings after this one in its series, that the user can see, in order. */
async function followingMeetings(
  supabase: Client,
  orgId: string,
  seriesId: string,
  index: number,
): Promise<{ rows: Array<{ id: string; starts_at: string; series_index: number }> } | { error: string }> {
  const { data, error } = await supabase
    .from("meetings")
    .select("id, starts_at, series_index")
    .eq("organization_id", orgId)
    .eq("series_id", seriesId)
    .gt("series_index", index)
    .eq("status", "planned")
    .order("series_index");
  if (error) return { error: dbErrorMessage(error) };
  return { rows: data.map((row) => ({ id: row.id, starts_at: row.starts_at, series_index: row.series_index ?? 0 })) };
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
  // CAL-09: cancelling may take the following meetings of the series with it (only those still planned)
  let skipped: string[] = [];
  if (parsed.data.status === "cancelled" && seriesScopeSchema.parse(formData.get("series_scope")) === "following") {
    const { data: current, error: readError } = await context.supabase
      .from("meetings")
      .select("series_id, series_index")
      .eq("organization_id", orgId)
      .eq("id", meetingId)
      .maybeSingle();
    if (readError) {
      return fail(dbErrorMessage(readError));
    }
    if (current?.series_id && current.series_index !== null) {
      const following = await followingMeetings(context.supabase, orgId, current.series_id, current.series_index);
      if ("error" in following) {
        return fail(following.error);
      }
      if (following.rows.length > 0) {
        const { data: rows, error: cancelError } = await context.supabase
          .from("meetings")
          .update({ status: "cancelled" })
          .eq("organization_id", orgId)
          .in("id", following.rows.map((row) => row.id))
          // a meeting marked held meanwhile stays held (review, 15 October 2026)
          .eq("status", "planned")
          .select("id, lead_id, contact_id, company_id, deal_id");
        if (cancelError) {
          return fail(dbErrorMessage(cancelError, "הפגישה עודכנה, אבל לא הצלחנו לבטל את הבאות בסדרה. נסו שוב."));
        }
        const cancelled = new Set(rows.map((row) => row.id));
        const timeZone = (await orgTimeZone(context.supabase, orgId)) ?? TIME_ZONE;
        skipped = following.rows.filter((row) => !cancelled.has(row.id)).map((row) => zoneDate(new Date(row.starts_at), timeZone));
        data.push(...rows);
      }
    }
  }
  revalidateMeeting(orgId, subject, data);
  if (skipped.length > 0) {
    return { ok: true, message: `הפגישה עודכנה. ${skippedDatesText(skipped)}` };
  }
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

type Parsed = Extract<Awaited<ReturnType<typeof parseMeeting>>, { ok: true }>;
type Context = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>;

/**
 * CAL-09 (owner, 15 October 2026): "this and following" moved to another weekday. The old series
 * ends before this meeting: a new series (new id, index from 1) starts on the nearest date on the
 * new weekday, with the form's details, time, participants and reminder, as many meetings as are
 * left; then the old planned meetings from here on (hand-moved ones too) are removed with the
 * user's session. Past, held and cancelled meetings never change.
 * Order and safety: nothing is written until the user confirmed (`split_ok`) and every old
 * meeting is removable by them (public.meetings_removable, the delete policy); the new series is
 * made in one transaction first; the old meetings go in ONE delete statement (all the rows the
 * policy allows, or an error). If that delete fails, the new series is removed again (the
 * creator may always delete what they created) and nothing has changed; if even that fails, the
 * answer says so plainly.
 */
async function splitSeries(
  context: Context,
  orgId: string,
  meetingId: string,
  subject: TimelineSubject | null,
  current: { status: string; starts_at: string; series_id: string; series_index: number; owner_id: string | null } & LinkedRecords,
  following: Array<{ id: string; starts_at: string; series_index: number }>,
  parsed: Parsed,
  formData: FormData,
): Promise<MeetingFormState> {
  const { supabase } = context;
  const values = formValues(formData);
  const now = Date.now();
  if (current.status !== "planned" || Date.parse(current.starts_at) < now) {
    return fail("אפשר להעביר ליום אחר רק מפגישה מתוכננת שעוד לא עברה.", { values });
  }
  // the meetings that go: this one and the following planned ones that have not started yet
  const old = [
    { id: meetingId, starts_at: current.starts_at, series_index: current.series_index },
    ...following.filter((row) => Date.parse(row.starts_at) >= now),
  ];
  const ids = old.map((row) => row.id);
  const { data: removable, error: checkError } = await supabase.rpc("meetings_removable", { p_org: orgId, p_ids: ids });
  if (checkError) {
    return fail(dbErrorMessage(checkError), { values });
  }
  if (new Set(removable ?? []).size < ids.length) {
    return fail("אי אפשר להעביר את הסדרה ליום אחר: אין לך הרשאה למחוק את כל הפגישות הבאות בה. אפשר לשנות כל פגישה בנפרד.", { values });
  }

  const startDate = splitStartDate(zoneDate(new Date(current.starts_at), parsed.timeZone), parsed.form.date);
  const times = weeklySeriesTimes(startDate, parsed.form.start_time, parsed.form.end_time, parsed.timeZone, old.length);
  const base = { startsAt: current.starts_at, index: current.series_index };
  const moved = old.filter((row) => movedByHand(base, { startsAt: row.starts_at, index: row.series_index }, parsed.timeZone)).length;

  if (formData.get("split_ok") !== "1") {
    // one question: the split, and the usual warnings for the new meetings (rest days, clashes)
    const userIds = [...(current.owner_id ? [current.owner_id] : []), ...parsed.participants];
    const spans = times.map((t, i) => ({ span: { startsAt: t.starts_at, endsAt: t.ends_at }, excludeId: old[i]?.id }));
    const conflicts = await seriesConflicts(supabase, orgId, { spans, userIds, timeZone: parsed.timeZone, typeId: parsed.row.meeting_type_id });
    return {
      ok: false,
      message: splitWarningText(old.length, moved, longDay(startDate)),
      values,
      split: { text: splitWarningText(old.length, moved, longDay(startDate)) },
      ...(conflicts ? { conflicts, span: spans[0].span } : {}),
    };
  }

  const fields = {
    title: parsed.row.title,
    meeting_type: parsed.row.meeting_type,
    meeting_type_id: parsed.row.meeting_type_id,
    location: parsed.row.location,
    video_url: parsed.row.video_url,
    description: parsed.row.description,
    reminder_minutes: parsed.row.reminder_minutes,
    lead_id: current.lead_id,
    contact_id: current.contact_id,
    company_id: current.company_id,
    deal_id: current.deal_id,
  };
  const linked: LinkedRecords[] = [{ lead_id: current.lead_id, contact_id: current.contact_id, company_id: current.company_id, deal_id: current.deal_id }];

  if (times.length === 1) {
    // one meeting left: no series to make, it simply moves
    const { data, error } = await supabase.from("meetings").update({ ...parsed.row, ...times[0] }).eq("organization_id", orgId).eq("id", meetingId).select(LINKED);
    if (error) return fail(dbErrorMessage(error, "לא הצלחנו לשמור את הפגישה. נסו שוב."), { values });
    if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN, { values });
    await syncParticipants(supabase, orgId, meetingId, parsed.participants);
    revalidateMeeting(orgId, subject, data);
    return ok();
  }

  const { data: made, error: makeError } = await supabase.rpc("create_meeting_series", {
    p_org: orgId,
    p_meeting: fields,
    p_times: times,
    p_participants: parsed.participants,
  });
  if (makeError) {
    return fail(dbErrorMessage(makeError, "לא הצלחנו להעביר את הסדרה. דבר לא השתנה, נסו שוב."), { values });
  }

  const { data: removed, error: removeError } = await supabase
    .from("meetings")
    .delete()
    .eq("organization_id", orgId)
    .in("id", ids)
    .eq("status", "planned")
    .select("id");
  if (removeError) {
    // undo: the new series goes again, so nothing changed
    const newIds = ((made as { ids?: string[] } | null)?.ids ?? []).filter((id) => typeof id === "string");
    const { error: undoError } = newIds.length > 0 ? await supabase.from("meetings").delete().eq("organization_id", orgId).in("id", newIds) : { error: null };
    revalidateMeeting(orgId, subject, linked);
    return fail(
      undoError
        ? "הסדרה החדשה נקבעה, אבל הפגישות הקודמות לא נמחקו. בדקו את היומן ומחקו את הכפולות."
        : "לא הצלחנו להעביר את הסדרה. דבר לא השתנה, נסו שוב.",
      { values },
    );
  }
  revalidateMeeting(orgId, subject, linked);
  const left = ids.length - removed.length;
  if (left > 0) {
    // a meeting changed in between (held, cancelled or its rights): it stays, and the person is told
    return { ok: true, message: `הסדרה הועברה, אבל ${left === 1 ? "פגישה אחת" : `${left} פגישות`} מהסדרה הקודמת לא נמחקו כי השתנו בינתיים. בדקו את היומן.` };
  }
  return ok();
}

/** The meetings "delete this and following" would remove: from this one on, not yet started. */
async function deletableFollowing(supabase: Client, orgId: string, meetingId: string) {
  const { data: current, error } = await supabase
    .from("meetings")
    .select("series_id, series_index")
    .eq("organization_id", orgId)
    .eq("id", meetingId)
    .maybeSingle();
  if (error) return { error: dbErrorMessage(error) } as const;
  if (!current?.series_id || current.series_index === null) return { error: NOT_FOUND_OR_FORBIDDEN } as const;
  const { data: rows, error: readError } = await supabase
    .from("meetings")
    .select("id, starts_at, series_index, lead_id, contact_id, company_id, deal_id")
    .eq("organization_id", orgId)
    .eq("series_id", current.series_id)
    .gte("series_index", current.series_index);
  if (readError) return { error: dbErrorMessage(readError) } as const;
  return { rows: fromHereNotPast(rows.map((row) => ({ ...row, series_index: row.series_index ?? 0 })), current.series_index, Date.now()) } as const;
}

/** CAL-09: how many meetings "delete this and following" would remove, and the window's text. */
export async function seriesDeleteCountAction(orgId: string, meetingId: string): Promise<ActionResult<{ count: number; text: string }>> {
  const context = await actionContext(orgId, meetingId);
  if (!context.ok) return context;
  const found = await deletableFollowing(context.supabase, orgId, meetingId);
  if ("error" in found) return fail(found.error ?? NOT_FOUND_OR_FORBIDDEN);
  return ok({ count: found.rows.length, text: deleteFollowingText(found.rows.length) });
}

/**
 * CAL-09 (owner, 15 October 2026): delete this meeting and the following ones of its series, for a
 * series made by mistake. One by one with the user's session, by each meeting's own rights; the
 * dates not deleted are reported. Meetings already started are never included.
 */
export async function deleteFollowingMeetingsAction(orgId: string, meetingId: string, subject: TimelineSubject | null): Promise<ActionResult> {
  if (!validArg(subjectOrNone, subject)) {
    return fail(INVALID_ARGS);
  }
  const context = await actionContext(orgId, meetingId, ...(subject ? [subject.id] : []));
  if (!context.ok) return context;
  const { supabase } = context;
  const found = await deletableFollowing(supabase, orgId, meetingId);
  if ("error" in found) return fail(found.error ?? NOT_FOUND_OR_FORBIDDEN);
  const timeZone = (await orgTimeZone(supabase, orgId)) ?? TIME_ZONE;
  const skipped: string[] = [];
  const gone: LinkedRecords[] = [];
  for (const row of found.rows) {
    const { data, error } = await supabase.from("meetings").delete().eq("organization_id", orgId).eq("id", row.id).select(LINKED);
    if (error || data.length === 0) skipped.push(zoneDate(new Date(row.starts_at), timeZone));
    else gone.push(...data);
  }
  revalidateMeeting(orgId, subject, gone.length > 0 ? gone : [found.rows[0] ?? { lead_id: null, contact_id: null, company_id: null, deal_id: null }]);
  if (gone.length === 0 && skipped.length > 0) {
    return fail(`לא נמחקה אף פגישה. ${skippedDatesText(skipped)}`);
  }
  return skipped.length > 0 ? { ok: true, message: `${gone.length} פגישות נמחקו. ${skippedDatesText(skipped)}` } : ok();
}
