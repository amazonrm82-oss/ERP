"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, booleanArg, validArg } from "@/lib/action-args";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { getSessionUser } from "@/lib/auth";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN, SESSION_EXPIRED } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

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
  if (!validArg(booleanArg, required)) return fail(INVALID_ARGS);
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

/** Ten new backup codes, shown once; the old ones stop working. Needs a session that passed two-step verification. */
export async function createRecoveryCodesAction(): Promise<{ ok: true; codes: string[] } | { ok: false; message: string }> {
  if (!(await getSessionUser())) return fail(SESSION_EXPIRED);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("mfa_recovery_codes_create");
  if (error) {
    return fail(error.hint === "mfa:aal2_required" ? "צריך להיכנס עם קוד מאפליקציית האימות כדי ליצור קודי גיבוי. התנתקו, התחברו שוב ונסו שוב." : "לא הצלחנו ליצור קודים. נסו שוב.");
  }
  const codes = Array.isArray(data) ? data.filter((c): c is string => typeof c === "string") : [];
  return { ok: true, codes };
}

/** Called after turning two-step verification off: the backup codes belonged to it. */
export async function clearRecoveryCodesAction(): Promise<ActionResult> {
  if (!(await getSessionUser())) return fail(SESSION_EXPIRED);
  const supabase = await createClient();
  const { error } = await supabase.rpc("mfa_recovery_codes_clear");
  return error ? fail("לא הצלחנו למחוק את קודי הגיבוי.") : ok();
}
