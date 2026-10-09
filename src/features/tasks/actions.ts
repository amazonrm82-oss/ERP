"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import type { TaskInsert, TaskStatus } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { zoneDate, zonedIso, zoneTime } from "@/lib/format";
import { INVALID_ARGS } from "@/lib/action-args";
import { addDays } from "@/lib/calendar-grid";
import { recordPage } from "@/lib/record-types";
import { subjectSchema, SUBJECT_COLUMN, type TimelineSubject } from "@/features/activities/schema";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { TASK_FIELD_NAMES, taskSchema } from "./schema";

// A task with a date but no time is due at the start of the working day.
const DEFAULT_DUE_TIME = "09:00";

function revalidateTasks(orgId: string) {
  revalidatePath(paths.org(orgId));
  revalidatePath(paths.tasks(orgId));
}

function dueAt(date: string | null, time: string | null): string | null {
  return date ? zonedIso(date, `${time ?? DEFAULT_DUE_TIME}:00`) : null;
}

function remindAt(due: string | null, remind: string): string | null {
  return due && remind !== "" ? new Date(Date.parse(due) - Number(remind) * 60_000).toISOString() : null;
}

function schedule(data: { due_date: string | null; due_time: string | null; remind: string }) {
  const due = dueAt(data.due_date, data.due_time);
  return { due_at: due, remind_at: remindAt(due, data.remind) };
}

/** New task. Without an assignee it is the creator's (the database assigns it). */
export async function createTaskAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = taskSchema.safeParse(pick(formData, TASK_FIELD_NAMES));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  // an assignee from another organization fails the composite foreign key
  const { error } = await context.supabase.from("tasks").insert({
    organization_id: orgId,
    title: parsed.data.title,
    task_type: parsed.data.task_type,
    ...schedule(parsed.data),
    ...(parsed.data.owner_id ? { owner_id: parsed.data.owner_id } : {}),
  });
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו להוסיף את המשימה. נסו שוב."), { values: formValues(formData) });
  }

  revalidateTasks(orgId);
  return ok();
}

export async function updateTaskAction(
  orgId: string,
  taskId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const context = await actionContext(orgId, taskId);
  if (!context.ok) {
    return context;
  }
  const parsed = taskSchema.safeParse(pick(formData, TASK_FIELD_NAMES));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  const { data, error } = await context.supabase
    .from("tasks")
    .update({
      title: parsed.data.title,
      task_type: parsed.data.task_type,
      ...schedule(parsed.data),
      ...(parsed.data.owner_id ? { owner_id: parsed.data.owner_id } : {}),
    })
    .eq("organization_id", orgId)
    .eq("id", taskId)
    .is("deleted_at", null)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את המשימה. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  }

  revalidateTasks(orgId);
  return { ok: true };
}

async function setTaskStatus(orgId: string, taskId: string, status: TaskStatus): Promise<ActionResult> {
  const context = await actionContext(orgId, taskId);
  if (!context.ok) {
    return context;
  }
  // completed_at is stamped (and cleared) by the database from the status
  const { data, error } = await context.supabase
    .from("tasks")
    .update({ status })
    .eq("organization_id", orgId)
    .eq("id", taskId)
    .is("deleted_at", null)
    .select("id, lead_id, contact_id, company_id, deal_id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לעדכן את המשימה. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateTasks(orgId);
  // the record's own "משימות" card shows it too (FXU-01)
  const row = data[0];
  const linked = row.deal_id
    ? recordPage("deal", orgId, row.deal_id)
    : row.lead_id
      ? recordPage("lead", orgId, row.lead_id)
      : row.contact_id
        ? recordPage("contact", orgId, row.contact_id)
        : row.company_id
          ? recordPage("company", orgId, row.company_id)
          : null;
  if (linked) revalidatePath(linked);
  return ok();
}

export async function completeTaskAction(orgId: string, taskId: string): Promise<ActionResult> {
  return setTaskStatus(orgId, taskId, "done");
}

export async function reopenTaskAction(orgId: string, taskId: string): Promise<ActionResult> {
  return setTaskStatus(orgId, taskId, "open");
}

const QUICK_WHEN = { none: null, tomorrow: 1, week: 7 } as const;

/**
 * A task on a record, from the record's own card (FXU-01): one line, and
 * "מחר" or "בעוד שבוע" set the date (at the start of the working day). The task
 * is the creator's and is linked to the record, so it appears on both.
 */
export async function addRecordTaskAction(orgId: string, subject: TimelineSubject, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsedSubject = subjectSchema.safeParse(subject);
  if (!parsedSubject.success) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  const context = await actionContext(orgId, parsedSubject.data.id);
  if (!context.ok) {
    return context;
  }
  const parsed = taskSchema.safeParse({ title: formData.get("title"), due_date: null, due_time: null, owner_id: null, task_type: null, remind: null });
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const whenKey = String(formData.get("when") ?? "none");
  const days = whenKey in QUICK_WHEN ? QUICK_WHEN[whenKey as keyof typeof QUICK_WHEN] : null;
  const due = days === null ? null : dueAt(addDays(zoneDate(new Date()), days), null);

  const row: TaskInsert = { organization_id: orgId, title: parsed.data.title, task_type: "todo", due_at: due };
  row[SUBJECT_COLUMN[parsedSubject.data.kind]] = parsedSubject.data.id;
  // RLS: the user can write in the organization and can see the record (composite keys keep it inside)
  const { error } = await context.supabase.from("tasks").insert(row);
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו להוסיף את המשימה. נסו שוב."), { values: formValues(formData) });
  }
  revalidateTasks(orgId);
  revalidatePath(recordPage(parsedSubject.data.kind, orgId, parsedSubject.data.id));
  return ok();
}

const SNOOZE_DAYS = { tomorrow: 1, week: 7 } as const;
export type SnoozeWhen = keyof typeof SNOOZE_DAYS;

/**
 * Put a task off in one tap (TASK-05): to tomorrow or a week from today, at the
 * time of day it had (the start of the working day if it had none). A reminder
 * moves with it, the same time before.
 */
export async function snoozeTaskAction(orgId: string, taskId: string, when: SnoozeWhen): Promise<ActionResult> {
  if (typeof when !== "string" || !(when in SNOOZE_DAYS)) {
    return fail(INVALID_ARGS);
  }
  const context = await actionContext(orgId, taskId);
  if (!context.ok) {
    return context;
  }
  const { data: task, error: readError } = await context.supabase
    .from("tasks")
    .select("due_at, remind_at")
    .eq("organization_id", orgId)
    .eq("id", taskId)
    .is("deleted_at", null)
    .maybeSingle();
  if (readError) {
    return fail(dbErrorMessage(readError));
  }
  if (!task) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  const time = task.due_at ? zoneTime(new Date(task.due_at)) : DEFAULT_DUE_TIME;
  const due = dueAt(addDays(zoneDate(new Date()), SNOOZE_DAYS[when]), time);
  const remind = task.due_at && task.remind_at && due ? new Date(Date.parse(due) - (Date.parse(task.due_at) - Date.parse(task.remind_at))).toISOString() : null;

  const { data, error } = await context.supabase
    .from("tasks")
    .update({ due_at: due, remind_at: remind })
    .eq("organization_id", orgId)
    .eq("id", taskId)
    .is("deleted_at", null)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לדחות את המשימה. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateTasks(orgId);
  return ok();
}
