"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, booleanArg, directionArg, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { dealContactRoleNameSchema } from "./role-schema";
import { saveOrder } from "@/lib/reorder";

// CON-03 follow-up: owners and admins manage the list of deal contact roles; RLS refuses everyone else (0 rows / 42501).

function revalidateDealContactRoles(orgId: string) {
  revalidatePath(paths.settingsDealContactRoles(orgId));
  // the role menus on the deal pages and the roles shown on contact pages
  revalidatePath(paths.deals(orgId), "layout");
  revalidatePath(paths.contacts(orgId), "layout");
}

type Context = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>;

async function rolesOf(context: Context, orgId: string) {
  const { data, error } = await context.supabase
    .from("deal_contact_roles")
    .select("id, name, position")
    .eq("organization_id", orgId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  return { data: data ?? [], error };
}

export async function addDealContactRoleAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = dealContactRoleNameSchema.safeParse(pick(formData, ["name"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const existing = await rolesOf(context, orgId);
  if (existing.error) {
    return fail(dbErrorMessage(existing.error), { values: formValues(formData) });
  }
  const { error } = await context.supabase
    .from("deal_contact_roles")
    .insert({ organization_id: orgId, name: parsed.data.name, position: existing.data.length });
  if (error) {
    return fail(error.code === "23505" ? "התפקיד הזה כבר ברשימה." : dbErrorMessage(error, "לא הצלחנו להוסיף את התפקיד. נסו שוב."), {
      values: formValues(formData),
    });
  }
  revalidateDealContactRoles(orgId);
  return ok();
}

export async function renameDealContactRoleAction(orgId: string, roleId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, roleId);
  if (!context.ok) {
    return context;
  }
  const parsed = dealContactRoleNameSchema.safeParse(pick(formData, ["name"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { data, error } = await context.supabase
    .from("deal_contact_roles")
    .update({ name: parsed.data.name })
    .eq("organization_id", orgId)
    .eq("id", roleId)
    .select("id");
  if (error) {
    return fail(error.code === "23505" ? "התפקיד הזה כבר ברשימה." : dbErrorMessage(error, "לא הצלחנו לשמור. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateDealContactRoles(orgId);
  return ok();
}

/** A hidden role stays on the links that have it, but is no longer offered. */
export async function setDealContactRoleActiveAction(orgId: string, roleId: string, isActive: boolean): Promise<ActionResult> {
  if (!validArg(booleanArg, isActive)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, roleId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase
    .from("deal_contact_roles")
    .update({ is_active: isActive === true })
    .eq("organization_id", orgId)
    .eq("id", roleId)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateDealContactRoles(orgId);
  return ok();
}

export async function moveDealContactRoleAction(orgId: string, roleId: string, direction: "up" | "down"): Promise<ActionResult> {
  if (!validArg(directionArg, direction)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, roleId);
  if (!context.ok) {
    return context;
  }
  const { data: ordered, error: readError } = await rolesOf(context, orgId);
  if (readError) {
    return fail(dbErrorMessage(readError));
  }
  const index = ordered.findIndex((role) => role.id === roleId);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= ordered.length) {
    return ok();
  }
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  // FXD-07: the whole order in one call
  const orderError = await saveOrder(context.supabase, "deal_contact_roles", orgId, ordered.map((item) => item.id));
  if (orderError) {
    return fail(orderError);
  }
  revalidateDealContactRoles(orgId);
  return ok();
}

/** The links that had this role keep the contact on the deal, without a role (the foreign key clears it). */
export async function deleteDealContactRoleAction(orgId: string, roleId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, roleId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase.from("deal_contact_roles").delete().eq("organization_id", orgId).eq("id", roleId).select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateDealContactRoles(orgId);
  return ok();
}
