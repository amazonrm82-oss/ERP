"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, booleanArg, directionArg, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { recordTypeObjectArg, typeSchema, type RecordTypeObject } from "./schema";

// CON-02: owners and admins manage the lists; RLS refuses everyone else (0 rows / 42501).

const TAKEN = "הסוג הזה כבר ברשימה.";

function revalidateTypes(orgId: string) {
  revalidatePath(paths.settingsRecordTypes(orgId));
  // the forms, cards, lists and filters of contacts and companies
  revalidatePath(paths.contacts(orgId), "layout");
  revalidatePath(paths.companies(orgId), "layout");
}

type Context = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>;

async function typesOf(context: Context, orgId: string, object: RecordTypeObject) {
  const { data, error } = await context.supabase
    .from("record_type_options")
    .select("id, name, position")
    .eq("organization_id", orgId)
    .eq("object_type", object)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  return { data: data ?? [], error };
}

export async function addTypeAction(orgId: string, object: RecordTypeObject, _prev: FormState, formData: FormData): Promise<FormState> {
  if (!validArg(recordTypeObjectArg, object)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = typeSchema.safeParse(pick(formData, ["name"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const existing = await typesOf(context, orgId, object);
  if (existing.error) {
    return fail(dbErrorMessage(existing.error), { values: formValues(formData) });
  }
  const { error } = await context.supabase
    .from("record_type_options")
    .insert({ organization_id: orgId, object_type: object, name: parsed.data.name, position: existing.data.length });
  if (error) {
    return fail(error.code === "23505" ? TAKEN : dbErrorMessage(error, "לא הצלחנו להוסיף את הסוג. נסו שוב."), { values: formValues(formData) });
  }
  revalidateTypes(orgId);
  return ok();
}

export async function renameTypeAction(orgId: string, typeId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, typeId);
  if (!context.ok) {
    return context;
  }
  const parsed = typeSchema.safeParse(pick(formData, ["name"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { data, error } = await context.supabase
    .from("record_type_options")
    .update({ name: parsed.data.name })
    .eq("organization_id", orgId)
    .eq("id", typeId)
    .select("id");
  if (error) {
    return fail(error.code === "23505" ? TAKEN : dbErrorMessage(error, "לא הצלחנו לשמור. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  }
  revalidateTypes(orgId);
  return ok();
}

/** A hidden type stays on the records that have it, but is no longer offered. */
export async function setTypeActiveAction(orgId: string, typeId: string, isActive: boolean): Promise<ActionResult> {
  if (!validArg(booleanArg, isActive)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, typeId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase
    .from("record_type_options")
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
  revalidateTypes(orgId);
  return ok();
}

export async function moveTypeAction(orgId: string, object: RecordTypeObject, typeId: string, direction: "up" | "down"): Promise<ActionResult> {
  if (!validArg(recordTypeObjectArg, object) || !validArg(directionArg, direction)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, typeId);
  if (!context.ok) {
    return context;
  }
  const { data: ordered, error: readError } = await typesOf(context, orgId, object);
  if (readError) {
    return fail(dbErrorMessage(readError));
  }
  const index = ordered.findIndex((type) => type.id === typeId);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= ordered.length) {
    return ok();
  }
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  for (const [position, type] of ordered.entries()) {
    if (type.position !== position) {
      const { data, error } = await context.supabase
        .from("record_type_options")
        .update({ position })
        .eq("organization_id", orgId)
        .eq("id", type.id)
        .select("id");
      if (error) {
        return fail(dbErrorMessage(error));
      }
      if (data.length === 0) {
        return fail(NOT_FOUND_OR_FORBIDDEN);
      }
    }
  }
  revalidateTypes(orgId);
  return ok();
}

/** Records of this type are left without a type (the foreign key sets it to null). */
export async function deleteTypeAction(orgId: string, typeId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, typeId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase.from("record_type_options").delete().eq("organization_id", orgId).eq("id", typeId).select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateTypes(orgId);
  return ok();
}
