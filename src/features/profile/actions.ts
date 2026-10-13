"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { optionalPhone, optionalText, requiredText } from "@/lib/validation";

import { AVATARS_BUCKET, isOwnAvatarPath } from "./avatar";
import { isTimeZone } from "./working-hours";

const profileSchema = z.object({
  full_name: requiredText(120, "יש להזין שם מלא.", "השם ארוך מדי. אפשר עד 120 תווים."),
  phone: optionalPhone,
  // Hebrew only for now; English is reserved (the database accepts 'en')
  locale: z.literal("he", { error: "השפה שנבחרה אינה נתמכת." }),
  // "" = the organization's time zone
  timezone: z
    .preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string())
    .refine((value) => value === "" || isTimeZone(value), { error: "יש לבחור אזור זמן מהרשימה." })
    .transform((value) => (value === "" ? null : value)),
  signature: optionalText(500, "החתימה ארוכה מדי. אפשר עד 500 תווים."),
});

/** Saves the signed-in user's own profile (USR-01). Applies in every organization. Working hours: saveMemberHoursAction (CAP-09). */
export async function saveProfileAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = profileSchema.safeParse({
    full_name: formData.get("full_name"),
    phone: formData.get("phone"),
    locale: formData.get("locale"),
    timezone: formData.get("timezone"),
    signature: formData.get("signature"),
  });
  if (!parsed.success) return invalid(parsed.error, formData);
  const { data, error } = await context.supabase
    .from("profiles")
    .update({
      full_name: parsed.data.full_name,
      phone: parsed.data.phone,
      locale: parsed.data.locale,
      timezone: parsed.data.timezone,
      signature: parsed.data.signature,
    })
    .eq("id", context.user.id)
    .select("id");
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו לשמור. נסו שוב."), { values: formValues(formData) });
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(paths.settingsAccount(orgId));
  return { ok: true, message: "הפרטים נשמרו." };
}

/** The photo the browser just uploaded becomes the profile photo; the old one is removed. */
export async function setAvatarAction(orgId: string, path: string): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  if (!isOwnAvatarPath(path, context.user.id)) return fail(INVALID_ARGS);
  return replaceAvatar(orgId, context, path);
}

/** Removes the profile photo. */
export async function removeAvatarAction(orgId: string): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  return replaceAvatar(orgId, context, null);
}

async function replaceAvatar(
  orgId: string,
  context: Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>,
  path: string | null,
): Promise<ActionResult> {
  const { supabase, user } = context;
  const { data: before, error: readError } = await supabase.from("profiles").select("avatar_url").eq("id", user.id).maybeSingle();
  if (readError) return fail(dbErrorMessage(readError));
  const { data, error } = await supabase.from("profiles").update({ avatar_url: path }).eq("id", user.id).select("id");
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו לשמור את התמונה. נסו שוב."));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  const old = before?.avatar_url;
  if (old && old !== path && isOwnAvatarPath(old, user.id)) {
    // best effort: a photo left behind is only the user's own, in their own folder
    await supabase.storage.from(AVATARS_BUCKET).remove([old]);
  }
  revalidatePath(paths.settingsAccount(orgId));
  return ok();
}
