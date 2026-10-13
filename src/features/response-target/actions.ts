"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { responseSettingsPath } from "./paths";
import { RESPONSE_FIELD_NAMES, responseSettingsSchema } from "./schema";

const SAVE_FAILED = "לא הצלחנו לשמור את יעד זמן התגובה. נסו שוב.";

/**
 * Saves the response target and the breach action (CAP-10). Owners and admins of a
 * writable organization only, enforced by RLS (0 rows = not permitted); audited by the
 * database. Updates the organization's row, or creates it the first time; a second
 * first save at the same moment hits the unique key and updates instead.
 */
export async function saveResponseSettingsAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = responseSettingsSchema.safeParse(pick(formData, RESPONSE_FIELD_NAMES));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const values = parsed.data;
  const update = () => context.supabase.from("lead_response_settings").update(values).eq("organization_id", orgId).select("id");

  let { data, error } = await update();
  if (!error && (data?.length ?? 0) === 0) {
    const inserted = await context.supabase.from("lead_response_settings").insert({ organization_id: orgId, ...values }).select("id");
    if (inserted.error?.code === "23505") {
      ({ data, error } = await update());
    } else if (inserted.error?.code === "42501") {
      data = [];
      error = null;
    } else {
      ({ data, error } = inserted);
    }
  }
  if (error) {
    return fail(dbErrorMessage(error, SAVE_FAILED), { values: formValues(formData) });
  }
  if ((data?.length ?? 0) === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  }
  revalidatePath(responseSettingsPath(orgId));
  return { ok: true, message: "יעד זמן התגובה נשמר." };
}
