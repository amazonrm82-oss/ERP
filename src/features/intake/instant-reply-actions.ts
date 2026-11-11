"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { checkbox } from "@/lib/validation";

const SAVE_FAILED = "לא הצלחנו לשמור. נסו שוב.";

/**
 * SPD-04 (owner (259) א): the business default of the instant reply, org_message_settings.instant_reply_default; a new web
 * form starts with it (trigger forms_instant_reply_default). One row per business: update, else insert, retry on 23505; the
 * user's session decides (owners and admins of a writable business; 0 rows = not permitted).
 */
export async function saveInstantReplyDefaultAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const value = checkbox.parse(formData.get("instant_reply_default"));
  const update = () =>
    context.supabase.from("org_message_settings").update({ instant_reply_default: value }).eq("organization_id", orgId).select("id");
  let { data, error } = await update();
  if (!error && (data?.length ?? 0) === 0) {
    const inserted = await context.supabase.from("org_message_settings").insert({ organization_id: orgId, instant_reply_default: value }).select("id");
    if (inserted.error?.code === "23505") {
      ({ data, error } = await update());
    } else if (inserted.error?.code === "42501") {
      data = [];
      error = null;
    } else {
      ({ data, error } = inserted);
    }
  }
  if (error) return fail(dbErrorMessage(error, SAVE_FAILED));
  if ((data?.length ?? 0) === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(paths.settingsIntake(orgId));
  return { ok: true, message: "ההגדרה נשמרה." };
}
