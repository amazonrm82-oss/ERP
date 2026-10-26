"use server";

import { revalidatePath } from "next/cache";

import { quickLogType, typeRefused } from "@/features/activity-types/quick-log";
import { booleanArg, INVALID_ARGS, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, invalid, formValues, ok, type ActionResult, type FormState } from "@/lib/action-result";
import type { ActivityInsert, ActivityUpdate } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { addDays } from "@/lib/calendar-grid";
import { zoneDate, zonedIso } from "@/lib/format";
import { recordPage } from "@/lib/record-types";
import { isActivityBase, parseChoice } from "@/features/activity-types/types";

const TYPE_GONE = "הסוג שנבחר כבר לא ברשימה. רעננו את הדף ובחרו סוג אחר.";
import type { TaskInsert } from "@/lib/database.types";

import {
  CALL_OUTCOME_LABEL,
  callLogSchema,
  IMPORT_NOTE_LOCKED,
  NOTE_LOCKED,
  noteEditSchema,
  noteSchema,
  PINNABLE_TYPES,
  PRIVATE_NOTE_TYPE,
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

/** Adds a user note to the timeline of a lead, contact, company or deal; answers its id (REC-07 attaches files to it). */
export async function addNoteAction(
  orgId: string,
  subject: TimelineSubject,
  _prev: FormState<{ id: string }>,
  formData: FormData,
): Promise<FormState<{ id: string }>> {
  const parsedSubject = subjectSchema.safeParse(subject);
  if (!parsedSubject.success) {
    return fail(NOT_FOUND);
  }
  const context = await actionContext(orgId, parsedSubject.data.id);
  if (!context.ok) {
    return context;
  }

  // TASK-08: the form sends a base kind, or a type of the business's list ("t:<id>"), whose kind is read from the list
  const rawType = formData.get("type");
  const choice = parseChoice(rawType === null || rawType === "" ? "note" : rawType);
  if (!choice) {
    return fail("יש לבחור סוג.", { values: formValues(formData), fieldErrors: { type: "יש לבחור סוג." } });
  }
  let base = "base" in choice ? choice.base : null;
  if ("typeId" in choice) {
    const { data: type, error: typeError } = await context.supabase
      .from("activity_types")
      .select("base_type")
      .eq("organization_id", orgId)
      .eq("id", choice.typeId)
      .maybeSingle();
    if (typeError) {
      return fail(dbErrorMessage(typeError), { values: formValues(formData) });
    }
    if (!type || !isActivityBase(type.base_type)) {
      return fail(TYPE_GONE, { values: formValues(formData), fieldErrors: { type: TYPE_GONE } });
    }
    base = type.base_type;
  }
  const parsed = noteSchema.safeParse({ ...pick(formData, ["body", "private"]), type: base });
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  // RLS: allowed when the user can write in the organization and can see the record.
  // GAP-05: a private note is seen by its author and the owners/admins only (activities_select).
  const row: ActivityInsert = {
    organization_id: orgId,
    type: parsed.data.type,
    body: parsed.data.body,
    is_private: parsed.data.private,
    // TASK-08: the database checks the type is active and of this kind (activities_activity_type)
    activity_type_id: "typeId" in choice ? choice.typeId : null,
  };
  row[SUBJECT_COLUMN[parsedSubject.data.kind]] = parsedSubject.data.id;
  const { data, error } = await context.supabase.from("activities").insert(row).select("id").single();
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את ההערה. נסו שוב."), { values: formValues(formData) });
  }

  const path = subjectPath(orgId, parsedSubject.data);
  if (path) {
    revalidatePath(path);
  }
  return ok({ id: data.id });
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

  // TASK-08: the business's call type (its seeded default, else its first active one), when it has one
  const typeId = await quickLogType(context.supabase, orgId, "call");
  const activity: ActivityInsert = { organization_id: orgId, type: "call", body: parsed.data.body, metadata: { outcome: parsed.data.outcome }, activity_type_id: typeId };
  activity[column] = parsedSubject.data.id;
  let { error } = await context.supabase.from("activities").insert(activity);
  if (error && typeId && typeRefused(error)) {
    // the type was hidden or removed meanwhile: log the call with its kind alone
    ({ error } = await context.supabase.from("activities").insert({ ...activity, activity_type_id: null }));
  }
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
 * With the user's session: RLS lets the author, a manager of the record's team or an owner/admin
 * of a writable organization change it. Zero rows back means deleted, not on this record, or not permitted.
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
 * GAP-05: the edit box of a note also says whether it is private (same rule: the author for
 * 24 hours, an owner/admin always); only a note is touched then.
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
  const parsed = noteEditSchema.safeParse(pick(formData, ["body", "private_field", "private"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  const change: ActivityUpdate = { body: parsed.data.body };
  if (parsed.data.private_field) {
    change.is_private = parsed.data.private;
  }
  const { data, error } = await context.supabase
    .from("activities")
    .update(change)
    .eq("organization_id", orgId)
    .eq("id", activityId)
    .eq(SUBJECT_COLUMN[parsedSubject.data.kind], parsedSubject.data.id)
    .in("type", parsed.data.private_field ? [PRIVATE_NOTE_TYPE] : [...PINNABLE_TYPES])
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

/** GAP-12: removes a note an import wrote. The activities_delete policy lets only owners and admins remove it. */
export async function deleteImportNoteAction(orgId: string, subject: TimelineSubject, activityId: string): Promise<ActionResult> {
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
    .eq("type", "import_note")
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו למחוק. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(IMPORT_NOTE_LOCKED);
  }
  revalidatePath(recordPage(parsedSubject.data.kind, orgId, parsedSubject.data.id));
  return ok();
}
