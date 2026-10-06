"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { zonedIso } from "@/lib/format";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { createTaskSchema } from "./schema";

// A task with a date but no time is due at the start of the working day.
const DEFAULT_DUE_TIME = "09:00:00";

/** Quick-add: a task for the signed-in user (the database assigns it to its creator). */
export async function createTaskAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = createTaskSchema.safeParse(pick(formData, ["title", "due_date"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  const { error } = await context.supabase.from("tasks").insert({
    organization_id: orgId,
    title: parsed.data.title,
    due_at: parsed.data.due_date ? zonedIso(parsed.data.due_date, DEFAULT_DUE_TIME) : null,
  });
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו להוסיף את המשימה. נסו שוב."), { values: formValues(formData) });
  }

  revalidatePath(paths.org(orgId));
  return ok();
}

export async function completeTaskAction(orgId: string, taskId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, taskId);
  if (!context.ok) {
    return context;
  }

  // completed_at is stamped by the database when status becomes "done"
  const { data, error } = await context.supabase
    .from("tasks")
    .update({ status: "done" })
    .eq("organization_id", orgId)
    .eq("id", taskId)
    .is("deleted_at", null)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לסמן את המשימה. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }

  revalidatePath(paths.org(orgId));
  return ok();
}
