"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";

import { parseDigestForm } from "./settings";

const SAVE_FAILED = "לא הצלחנו לשמור. נסו שוב.";

/**
 * USR-11 / WAB-03: saves the person's own daily summary switch and time in this business. One row per person and business:
 * update and select back, insert only when there was none, update again once on 23505 (two tabs saving at once).
 */
export async function saveDigestSettingsAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = parseDigestForm(formData.get("digest_enabled"), formData.get("digest_send_at"));
  if (!parsed.ok) {
    return fail(parsed.message, { fieldErrors: { digest_send_at: parsed.message } });
  }
  const values = { enabled: parsed.settings.enabled, send_at: parsed.settings.sendAt };
  const update = () =>
    context.supabase.from("digest_settings").update(values).eq("organization_id", orgId).eq("user_id", context.user.id).select("id");
  let result = await update();
  if (!result.error && (result.data ?? []).length === 0) {
    const inserted = await context.supabase.from("digest_settings").insert({ organization_id: orgId, ...values }).select("id");
    result = inserted.error?.code === "23505" ? await update() : inserted;
  }
  if (result.error) {
    return fail(dbErrorMessage(result.error, SAVE_FAILED));
  }
  if ((result.data ?? []).length === 0) {
    return fail(SAVE_FAILED);
  }
  revalidatePath(paths.settingsAccount(orgId));
  return { ok: true, message: parsed.settings.enabled ? "הסיכום היומי הופעל." : "הסיכום היומי כבוי." };
}
