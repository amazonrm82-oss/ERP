"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { anomalyAlertSettingsPath } from "./paths";
import { ANOMALY_FIELD_NAMES, anomalyAlertSettingsSchema } from "./settings";

const SAVE_FAILED = "לא הצלחנו לשמור. נסו שוב.";

/**
 * MNY-04 (285) ג: saves the business's switches and numbers with the user's session (owners and admins of a writable business,
 * RLS; 0 rows = not permitted). Updates the row, or inserts it the first time; a first save racing another hits the unique
 * key and updates.
 */
export async function saveAnomalyAlertSettingsAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = anomalyAlertSettingsSchema.safeParse(pick(formData, ANOMALY_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  const values = parsed.data;
  const update = () => context.supabase.from("anomaly_alert_settings").update(values).eq("organization_id", orgId).select("id");

  let { data, error } = await update();
  if (!error && (data?.length ?? 0) === 0) {
    const inserted = await context.supabase.from("anomaly_alert_settings").insert({ organization_id: orgId, ...values }).select("id");
    if (inserted.error?.code === "23505") {
      ({ data, error } = await update());
    } else if (inserted.error?.code === "42501") {
      data = [];
      error = null;
    } else {
      ({ data, error } = inserted);
    }
  }
  if (error) return fail(dbErrorMessage(error, SAVE_FAILED), { values: formValues(formData) });
  if ((data?.length ?? 0) === 0) return fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  revalidatePath(anomalyAlertSettingsPath(orgId));
  return { ok: true, message: "ההגדרה נשמרה." };
}
