"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";

/** Signs out every other browser and phone of this user; this one stays signed in. */
export async function signOutOthersAction(orgId: string): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const { error } = await context.supabase.auth.signOut({ scope: "others" });
  if (error) return fail("לא הצלחנו לנתק את המכשירים האחרים. נסו שוב.");
  revalidatePath(paths.settingsAccount(orgId));
  return ok();
}

/** Organization-wide two-step verification (owner and admins; the database checks). */
export async function setRequireMfaAction(orgId: string, required: boolean): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.from("organizations").update({ require_mfa: required }).eq("id", orgId).select("id");
  if (error) {
    return fail(error.hint === "mfa:self_first" ? "קודם הפעילו אימות דו-שלבי בחשבון שלכם (בלשונית \"החשבון שלי\"), ואז אפשר לחייב את כולם." : dbErrorMessage(error, "לא הצלחנו לשמור."));
  }
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(paths.settings(orgId));
  return ok();
}
