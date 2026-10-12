"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";

import { calendarSettingsFromForm, calendarSettingsSchema } from "./schema";

const SAVE_FAILED = "לא הצלחנו לשמור את ימי המנוחה. נסו שוב.";

/** Saves the organization's rest days (owners and admins; RLS decides). */
export async function saveCalendarSettingsAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = calendarSettingsSchema.safeParse(calendarSettingsFromForm(formData));
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? SAVE_FAILED);
  }
  const values = parsed.data;

  // update the organization's row, or create it the first time
  const { data, error } = await context.supabase
    .from("org_calendar_settings")
    .update(values)
    .eq("organization_id", orgId)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, SAVE_FAILED));
  }
  if (data.length === 0) {
    const { error: insertError } = await context.supabase
      .from("org_calendar_settings")
      .insert({ organization_id: orgId, ...values })
      .select("id")
      .single();
    if (insertError) {
      return fail(dbErrorMessage(insertError, SAVE_FAILED));
    }
  }

  // the calendar and every screen that counts work days read these
  revalidatePath(paths.org(orgId), "layout");
  return { ok: true, message: "ימי המנוחה נשמרו." };
}
