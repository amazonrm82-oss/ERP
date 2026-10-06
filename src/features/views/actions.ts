"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick, requiredText } from "@/lib/validation";

import { cleanFilters, VIEW_OBJECTS, type ViewObject } from "./types";

const LIST_PATH = { lead: paths.leads, contact: paths.contacts, company: paths.companies } as const;

const viewSchema = z.object({
  name: requiredText(80, "יש לתת שם לתצוגה.", "השם ארוך מדי (עד 80 תווים)."),
  scope: z.enum(["private", "org"], { error: "יש לבחור למי התצוגה." }),
});

/** Saves the list's current filters under a name: for oneself, or (admins) for everyone. */
export async function saveViewAction(orgId: string, objectType: ViewObject, _prev: FormState, formData: FormData): Promise<FormState> {
  if (!VIEW_OBJECTS.includes(objectType)) {
    return fail(NOT_FOUND);
  }
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = viewSchema.safeParse(pick(formData, ["name", "scope"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const filters = cleanFilters(pick(formData, ["q", "status", "tag"]));

  // a shared ("org") view needs an admin: the insert policy rejects it otherwise
  const { error } = await context.supabase.from("saved_views").insert({
    organization_id: orgId,
    object_type: objectType,
    name: parsed.data.name,
    scope: parsed.data.scope,
    owner_id: context.user.id,
    config: { filters },
  });
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את התצוגה. נסו שוב."), { values: formValues(formData) });
  }
  revalidatePath(LIST_PATH[objectType](orgId));
  return { ok: true, message: "התצוגה נשמרה." };
}

export async function deleteViewAction(orgId: string, objectType: ViewObject, viewId: string): Promise<ActionResult> {
  if (!VIEW_OBJECTS.includes(objectType)) {
    return fail(NOT_FOUND);
  }
  const context = await actionContext(orgId, viewId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase.from("saved_views").delete().eq("organization_id", orgId).eq("id", viewId).select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(LIST_PATH[objectType](orgId));
  return ok();
}
