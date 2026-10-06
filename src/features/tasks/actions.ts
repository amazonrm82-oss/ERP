"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import type { TaskStatus } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { zonedIso } from "@/lib/format";
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
    due_at: dueAt(parsed.data.due_date, parsed.data.due_time),
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
      due_at: dueAt(parsed.data.due_date, parsed.data.due_time),
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
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לעדכן את המשימה. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateTasks(orgId);
  return ok();
}

export async function completeTaskAction(orgId: string, taskId: string): Promise<ActionResult> {
  return setTaskStatus(orgId, taskId, "done");
}

export async function reopenTaskAction(orgId: string, taskId: string): Promise<ActionResult> {
  return setTaskStatus(orgId, taskId, "open");
}
