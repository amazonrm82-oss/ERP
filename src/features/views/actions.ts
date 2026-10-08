"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick, requiredText } from "@/lib/validation";

import { columnChoicesSchema } from "@/features/list-columns/columns";

import { cleanFilters, VIEW_OBJECTS, VIEW_SORT_RE, type ViewObject } from "./types";

const LIST_PATH = { lead: paths.leads, contact: paths.contacts, company: paths.companies } as const;

const viewSchema = z
  .object({
    name: requiredText(80, "יש לתת שם לתצוגה.", "השם ארוך מדי (עד 80 תווים)."),
    scope: z.enum(["private", "team", "org"], { error: "יש לבחור למי התצוגה." }),
    team_id: z.string().nullish(),
  })
  .refine((v) => v.scope !== "team" || z.guid().safeParse(v.team_id).success, { path: ["team_id"], error: "יש לבחור צוות." });

/** The columns sent with the form (JSON), or null when they are missing or malformed. */
function readColumns(raw: FormDataEntryValue | null) {
  try {
    const parsed = columnChoicesSchema.safeParse(JSON.parse(String(raw ?? "null")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Saves the list's current filters, sort and columns under a name (LST-04): for
 * oneself, for a team (its members, or an admin), or (admins) for everyone.
 */
export async function saveViewAction(orgId: string, objectType: ViewObject, _prev: FormState, formData: FormData): Promise<FormState> {
  if (!VIEW_OBJECTS.includes(objectType)) {
    return fail(NOT_FOUND);
  }
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = viewSchema.safeParse(pick(formData, ["name", "scope", "team_id"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const filters = cleanFilters(pick(formData, ["q", "status", "tag"]));
  const sortRaw = String(formData.get("sort") ?? "");
  const sort = VIEW_SORT_RE.test(sortRaw) ? sortRaw : null;
  const columns = readColumns(formData.get("columns"));

  // the insert policy decides who may share: a team view needs a member of the team or an admin, "org" an admin
  const { error } = await context.supabase.from("saved_views").insert({
    organization_id: orgId,
    object_type: objectType,
    name: parsed.data.name,
    scope: parsed.data.scope,
    team_id: parsed.data.scope === "team" ? (parsed.data.team_id ?? null) : null,
    owner_id: context.user.id,
    config: { filters, sort, columns },
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
