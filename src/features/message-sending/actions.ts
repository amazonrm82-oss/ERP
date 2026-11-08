"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { messageSendingSettingsPath } from "./paths";
import { MESSAGE_CAP_FIELD_NAMES, messageCapsSchema, SENDING_HOURS_FIELD_NAMES, sendingHoursSchema } from "./schema";

const SAVE_FAILED = "לא הצלחנו לשמור. נסו שוב.";

type Values = {
  window_from?: string;
  window_until?: string;
  skip_rest_days?: boolean;
  monthly_cap_email?: number | null;
  monthly_cap_sms?: number | null;
  monthly_cap_whatsapp?: number | null;
};

/**
 * One row per business (org_message_settings): update it, or insert it the first time; a first save racing another hits the
 * unique key and updates. The user's session decides (owners and admins of a writable business; 0 rows = not permitted).
 */
async function saveSettings(orgId: string, values: Values, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const update = () => context.supabase.from("org_message_settings").update(values).eq("organization_id", orgId).select("id");

  let { data, error } = await update();
  if (!error && (data?.length ?? 0) === 0) {
    const inserted = await context.supabase.from("org_message_settings").insert({ organization_id: orgId, ...values }).select("id");
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
  revalidatePath(messageSendingSettingsPath(orgId));
  return { ok: true, message: "ההגדרה נשמרה." };
}

/** MSG-06: the sending window of messages to customers. */
export async function saveSendingHoursAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = sendingHoursSchema.safeParse(pick(formData, SENDING_HOURS_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  return saveSettings(orgId, parsed.data, formData);
}

/** MSG-05: the monthly caps of marketing messages (empty = no cap of the business). */
export async function saveMessageCapsAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = messageCapsSchema.safeParse(pick(formData, MESSAGE_CAP_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  return saveSettings(orgId, parsed.data, formData);
}
