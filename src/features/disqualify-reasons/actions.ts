"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, booleanArg, directionArg, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { reasonSchema } from "./schema";

// LEAD-03: owners and admins manage the list; RLS refuses everyone else (0 rows / 42501).

function revalidateReasons(orgId: string) {
  revalidatePath(paths.settingsDisqualifyReasons(orgId));
  // the status pickers on the leads list, board and lead pages
  revalidatePath(paths.leads(orgId), "layout");
}

type Context = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>;

async function reasonsOf(context: Context, orgId: string) {
  const { data, error } = await context.supabase
    .from("disqualify_reasons")
    .select("id, name, position")
    .eq("organization_id", orgId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  return { data: data ?? [], error };
}

export async function addReasonAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = reasonSchema.safeParse(pick(formData, ["name"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const existing = await reasonsOf(context, orgId);
  if (existing.error) {
    return fail(dbErrorMessage(existing.error), { values: formValues(formData) });
  }
  const { error } = await context.supabase
    .from("disqualify_reasons")
    .insert({ organization_id: orgId, name: parsed.data.name, position: existing.data.length });
  if (error) {
    return fail(error.code === "23505" ? "הסיבה הזו כבר ברשימה." : dbErrorMessage(error, "לא הצלחנו להוסיף את הסיבה. נסו שוב."), {
      values: formValues(formData),
    });
  }
  revalidateReasons(orgId);
  return ok();
}

export async function renameReasonAction(orgId: string, reasonId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, reasonId);
  if (!context.ok) {
    return context;
  }
  const parsed = reasonSchema.safeParse(pick(formData, ["name"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { data, error } = await context.supabase
    .from("disqualify_reasons")
    .update({ name: parsed.data.name })
    .eq("organization_id", orgId)
    .eq("id", reasonId)
    .select("id");
  if (error) {
    return fail(error.code === "23505" ? "הסיבה הזו כבר ברשימה." : dbErrorMessage(error, "לא הצלחנו לשמור. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateReasons(orgId);
  return ok();
}

/** A hidden reason stays on the leads that have it, but is no longer offered. */
export async function setReasonActiveAction(orgId: string, reasonId: string, isActive: boolean): Promise<ActionResult> {
  if (!validArg(booleanArg, isActive)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, reasonId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase
    .from("disqualify_reasons")
    .update({ is_active: isActive === true })
    .eq("organization_id", orgId)
    .eq("id", reasonId)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateReasons(orgId);
  return ok();
}

export async function moveReasonAction(orgId: string, reasonId: string, direction: "up" | "down"): Promise<ActionResult> {
  if (!validArg(directionArg, direction)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, reasonId);
  if (!context.ok) {
    return context;
  }
  const { data: ordered, error: readError } = await reasonsOf(context, orgId);
  if (readError) {
    return fail(dbErrorMessage(readError));
  }
  const index = ordered.findIndex((reason) => reason.id === reasonId);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= ordered.length) {
    return ok();
  }
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  for (const [position, reason] of ordered.entries()) {
    if (reason.position !== position) {
      const { data, error } = await context.supabase
        .from("disqualify_reasons")
        .update({ position })
        .eq("organization_id", orgId)
        .eq("id", reason.id)
        .select("id");
      if (error) {
        return fail(dbErrorMessage(error));
      }
      if (data.length === 0) {
        return fail(NOT_FOUND_OR_FORBIDDEN);
      }
    }
  }
  revalidateReasons(orgId);
  return ok();
}

/** Leads that were disqualified with this reason keep its name. */
export async function deleteReasonAction(orgId: string, reasonId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, reasonId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase.from("disqualify_reasons").delete().eq("organization_id", orgId).eq("id", reasonId).select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateReasons(orgId);
  return ok();
}
