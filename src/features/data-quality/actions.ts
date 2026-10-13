"use server";

import { revalidatePath } from "next/cache";

import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { z } from "zod";

import { completenessCatalog, completenessFieldsSchema, COMPLETENESS_TYPES, pickedKeys } from "./completeness";
import { completenessSettingsPath } from "./paths";

const typeArg = z.enum(COMPLETENESS_TYPES);

/** DQL-01: saves which fields count as important for one record type (owners and admins; RLS decides). */
export async function saveCompletenessFieldsAction(orgId: string, type: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  if (!validArg(typeArg, type)) {
    return fail(INVALID_ARGS);
  }
  const picked = formData.getAll("field").filter((value): value is string => typeof value === "string");
  const catalog = completenessCatalog(type, await listFieldDefinitions(orgId, type));
  const fields = pickedKeys(catalog, picked);
  if (!completenessFieldsSchema.safeParse(fields).success) {
    return fail(INVALID_ARGS);
  }

  const { data, error } = await context.supabase
    .from("completeness_settings")
    .update({ fields })
    .eq("organization_id", orgId)
    .eq("object_type", type)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    // no row yet (should not happen: every organization is seeded); RLS refuses a non-admin here too
    const inserted = await context.supabase.from("completeness_settings").insert({ organization_id: orgId, object_type: type, fields }).select("id");
    if (inserted.error) {
      return fail(inserted.error.code === "42501" ? NOT_FOUND_OR_FORBIDDEN : dbErrorMessage(inserted.error));
    }
  }
  revalidatePath(completenessSettingsPath(orgId));
  return { ok: true, message: "השינויים נשמרו." };
}
