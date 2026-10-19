"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, booleanArg, directionArg, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { saveOrder } from "@/lib/reorder";
import { pick } from "@/lib/validation";

import { activityTypesPath } from "./paths";
import { editActivityTypeSchema, newActivityTypeSchema } from "./schema";

// TASK-08: owners and admins manage the list of activity and task types; RLS refuses everyone else (0 rows / 42501).

const TAKEN = "יש כבר סוג בשם הזה.";

function revalidateActivityTypes(orgId: string) {
  revalidatePath(activityTypesPath(orgId));
  // the log forms and timelines of every record, and the task forms
  revalidatePath(`/o/${orgId}`, "layout");
  revalidatePath(paths.tasks(orgId));
}

type Context = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>;

async function typesOf(context: Context, orgId: string) {
  const { data, error } = await context.supabase
    .from("activity_types")
    .select("id, position")
    .eq("organization_id", orgId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  return { data: data ?? [], error };
}

export async function addActivityTypeAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = newActivityTypeSchema.safeParse(pick(formData, ["name", "base_type", "icon"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const existing = await typesOf(context, orgId);
  if (existing.error) {
    return fail(dbErrorMessage(existing.error), { values: formValues(formData) });
  }
  const { error } = await context.supabase.from("activity_types").insert({
    organization_id: orgId,
    name: parsed.data.name,
    base_type: parsed.data.base_type,
    icon: parsed.data.icon,
    position: existing.data.length,
  });
  if (error) {
    return fail(error.code === "23505" ? TAKEN : dbErrorMessage(error, "לא הצלחנו להוסיף את הסוג. נסו שוב."), { values: formValues(formData) });
  }
  revalidateActivityTypes(orgId);
  return ok();
}

export async function editActivityTypeAction(orgId: string, typeId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, typeId);
  if (!context.ok) {
    return context;
  }
  const parsed = editActivityTypeSchema.safeParse(pick(formData, ["name", "icon"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { data, error } = await context.supabase
    .from("activity_types")
    .update({ name: parsed.data.name, icon: parsed.data.icon })
    .eq("organization_id", orgId)
    .eq("id", typeId)
    .select("id");
  if (error) {
    return fail(error.code === "23505" ? TAKEN : dbErrorMessage(error, "לא הצלחנו לשמור. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateActivityTypes(orgId);
  return ok();
}

/** A hidden type stays on the entries and tasks that have it, but is no longer offered. */
export async function setActivityTypeActiveAction(orgId: string, typeId: string, isActive: boolean): Promise<ActionResult> {
  if (!validArg(booleanArg, isActive)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, typeId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase
    .from("activity_types")
    .update({ is_active: isActive === true })
    .eq("organization_id", orgId)
    .eq("id", typeId)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateActivityTypes(orgId);
  return ok();
}

export async function moveActivityTypeAction(orgId: string, typeId: string, direction: "up" | "down"): Promise<ActionResult> {
  if (!validArg(directionArg, direction)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, typeId);
  if (!context.ok) {
    return context;
  }
  const { data: ordered, error: readError } = await typesOf(context, orgId);
  if (readError) {
    return fail(dbErrorMessage(readError));
  }
  const index = ordered.findIndex((type) => type.id === typeId);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= ordered.length) {
    return ok();
  }
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  // FXD-07: the whole order in one call
  const orderError = await saveOrder(context.supabase, "activity_types", orgId, ordered.map((item) => item.id));
  if (orderError) {
    return fail(orderError);
  }
  revalidateActivityTypes(orgId);
  return ok();
}

/** Entries and tasks that had this type keep their kind; they show its built-in name (the foreign key clears the type). */
export async function deleteActivityTypeAction(orgId: string, typeId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, typeId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase.from("activity_types").delete().eq("organization_id", orgId).eq("id", typeId).select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateActivityTypes(orgId);
  return ok();
}
