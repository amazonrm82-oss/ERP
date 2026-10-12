"use server";

import { revalidatePath } from "next/cache";

import { booleanArg, INVALID_ARGS, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, invalid, formValues, ok, type ActionResult, type FormState } from "@/lib/action-result";
import type { ActivityInsert } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { addDays } from "@/lib/calendar-grid";
import { zoneDate, zonedIso } from "@/lib/format";
import { recordPage } from "@/lib/record-types";
import type { TaskInsert } from "@/lib/database.types";

import {
  CALL_OUTCOME_LABEL,
  callLogSchema,
  NOTE_LOCKED,
  noteEditSchema,
  noteSchema,
  PINNABLE_TYPES,
  subjectSchema,
  SUBJECT_COLUMN,
  type TimelineSubject,
} from "./schema";

function subjectPath(orgId: string, subject: TimelineSubject): string | null {
  switch (subject.kind) {
    case "lead":
      return paths.lead(orgId, subject.id);
    case "contact":
      return paths.contact(orgId, subject.id);
    default:
      return null;
  }
}

/** Adds a user note to the timeline of a lead, contact, company or deal. */
export async function addNoteAction(
  orgId: string,
  subject: TimelineSubject,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsedSubject = subjectSchema.safeParse(subject);
  if (!parsedSubject.success) {
    return fail(NOT_FOUND);
  }
  const context = await actionContext(orgId, parsedSubject.data.id);
  if (!context.ok) {
    return context;
  }

  const parsed = noteSchema.safeParse(pick(formData, ["type", "body"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  // RLS: allowed when the user can write in the organization and can see the record.
  const row: ActivityInsert = { organization_id: orgId, type: parsed.data.type, body: parsed.data.body };
  row[SUBJECT_COLUMN[parsedSubject.data.kind]] = parsedSubject.data.id;
  const { error } = await context.supabase.from("activities").insert(row);
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את ההערה. נסו שוב."), { values: formValues(formData) });
  }

  const path = subjectPath(orgId, parsedSubject.data);
  if (path) {
    revalidatePath(path);
  }
  return ok();
}

const NEXT_DAYS = { tomorrow: 1, week: 7 } as const;

/**
 * A call logged in one step (TASK-02): how it ended, a note, and the next step
 * as a task on the same record (at the start of the working day). With the
 * user's session; the call counts as contact with the customer, like any call.
 */
export async function logCallAction(orgId: string, subject: TimelineSubject, recordName: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsedSubject = subjectSchema.safeParse(subject);
  if (!parsedSubject.success || typeof recordName !== "string") {
    return fail(NOT_FOUND);
  }
  const context = await actionContext(orgId, parsedSubject.data.id);
  if (!context.ok) {
    return context;
  }
  const parsed = callLogSchema.safeParse(pick(formData, ["outcome", "body", "next", "next_title"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const column = SUBJECT_COLUMN[parsedSubject.data.kind];

  const activity: ActivityInsert = { organization_id: orgId, type: "call", body: parsed.data.body, metadata: { outcome: parsed.data.outcome } };
  activity[column] = parsedSubject.data.id;
  const { error } = await context.supabase.from("activities").insert(activity);
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את השיחה. נסו שוב."), { values: formValues(formData) });
  }

  if (parsed.data.next !== "none") {
    const name = recordName.trim().slice(0, 200);
    const title = parsed.data.next_title ?? (parsed.data.outcome === "answered" ? `המשך טיפול: ${name}` : `לחזור אל ${name}`);
    const task: TaskInsert = {
      organization_id: orgId,
      title,
      task_type: "call",
      due_at: zonedIso(addDays(zoneDate(new Date()), NEXT_DAYS[parsed.data.next]), "09:00:00"),
    };
    task[column] = parsedSubject.data.id;
    const { error: taskError } = await context.supabase.from("tasks").insert(task);
    if (taskError) {
      // the call is saved; say so, and that the task is missing
      return fail(`השיחה נשמרה, אבל לא הצלחנו ליצור את המשימה (${CALL_OUTCOME_LABEL[parsed.data.outcome]}). אפשר להוסיף אותה בכרטיס המשימות.`);
    }
    revalidatePath(paths.tasks(orgId));
    revalidatePath(paths.org(orgId));
  }

  revalidatePath(recordPage(parsedSubject.data.kind, orgId, parsedSubject.data.id));
  return ok();
}

/**
 * REC-01: pins an entry the user logged to the top of the record's timeline, or unpins it.
 * With the user's session: RLS lets the author or an owner/admin of a writable organization
 * change it. Zero rows back means deleted, not on this record, or not permitted.
 */
export async function setActivityPinnedAction(
  orgId: string,
  subject: TimelineSubject,
  activityId: string,
  pinned: boolean,
): Promise<ActionResult> {
  const parsedSubject = subjectSchema.safeParse(subject);
  if (!parsedSubject.success) {
    return fail(NOT_FOUND);
  }
  if (!validArg(booleanArg, pinned)) {
    return fail(INVALID_ARGS);
  }
  const context = await actionContext(orgId, parsedSubject.data.id, activityId);
  if (!context.ok) {
    return context;
  }

  const { data, error } = await context.supabase
    .from("activities")
    .update({ is_pinned: pinned })
    .eq("organization_id", orgId)
    .eq("id", activityId)
    .eq(SUBJECT_COLUMN[parsedSubject.data.kind], parsedSubject.data.id)
    .in("type", [...PINNABLE_TYPES])
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, pinned ? "לא הצלחנו לנעוץ. נסו שוב." : "לא הצלחנו לבטל את הנעיצה. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }

  revalidatePath(recordPage(parsedSubject.data.kind, orgId, parsedSubject.data.id));
  return ok();
}

/**
 * REC-05: edits the text of an entry a person logged. With the user's session: RLS lets the
 * author change it for 24 hours, and an owner/admin at any time; the database writes the
 * change to the audit log. Zero rows back means deleted, not on this record, or not permitted.
 */
export async function updateNoteAction(
  orgId: string,
  subject: TimelineSubject,
  activityId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsedSubject = subjectSchema.safeParse(subject);
  if (!parsedSubject.success) {
    return fail(NOT_FOUND);
  }
  const context = await actionContext(orgId, parsedSubject.data.id, activityId);
  if (!context.ok) {
    return context;
  }
  const parsed = noteEditSchema.safeParse(pick(formData, ["body"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  const { data, error } = await context.supabase
    .from("activities")
    .update({ body: parsed.data.body })
    .eq("organization_id", orgId)
    .eq("id", activityId)
    .eq(SUBJECT_COLUMN[parsedSubject.data.kind], parsedSubject.data.id)
    .in("type", [...PINNABLE_TYPES])
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את השינוי. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOTE_LOCKED, { values: formValues(formData) });
  }

  revalidatePath(recordPage(parsedSubject.data.kind, orgId, parsedSubject.data.id));
  return ok();
}

/** REC-05: deletes an entry a person logged, under the same rule as editing it. */
export async function deleteNoteAction(orgId: string, subject: TimelineSubject, activityId: string): Promise<ActionResult> {
  const parsedSubject = subjectSchema.safeParse(subject);
  if (!parsedSubject.success) {
    return fail(NOT_FOUND);
  }
  const context = await actionContext(orgId, parsedSubject.data.id, activityId);
  if (!context.ok) {
    return context;
  }

  const { data, error } = await context.supabase
    .from("activities")
    .delete()
    .eq("organization_id", orgId)
    .eq("id", activityId)
    .eq(SUBJECT_COLUMN[parsedSubject.data.kind], parsedSubject.data.id)
    .in("type", [...PINNABLE_TYPES])
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו למחוק. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOTE_LOCKED);
  }

  revalidatePath(recordPage(parsedSubject.data.kind, orgId, parsedSubject.data.id));
  return ok();
}
