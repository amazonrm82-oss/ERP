"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";

import { BUILT_MEMBER_PERMISSIONS, isMemberPermission } from "./keys";
import { memberPermissionsPath } from "./paths";

/**
 * PRM-01: saves the whole set of a member's extra permissions. The form sends one
 * `permission` value per ticked box. Only keys whose module is built are on the
 * screen and may be granted; a key of a module not built yet held from before stays.
 * set_member_permissions() checks the caller (owner or admin), the target, the plan
 * and the keys again, and writes the audit entry.
 */
export async function setMemberPermissionsAction(orgId: string, userId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, userId);
  if (!context.ok) return context;
  const ticked = formData.getAll("permission").map(String);
  if (!ticked.every(isMemberPermission)) {
    return fail("אחת ההרשאות אינה מוכרת. רעננו את הדף ונסו שוב.");
  }
  // keys whose module is not built yet are not on the screen and cannot be granted (the database refuses
  // them too); one held from before is kept as it is
  const shown = new Set<string>(BUILT_MEMBER_PERMISSIONS);
  const { data: current, error: readError } = await context.supabase
    .from("member_permissions")
    .select("permissions")
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  if (readError) return fail(dbErrorMessage(readError));
  const kept = (current?.permissions ?? []).filter((key) => isMemberPermission(key) && !shown.has(key));
  if (!ticked.every((key) => shown.has(key))) {
    return fail("אחת ההרשאות עוד לא זמינה. רעננו את הדף ונסו שוב.");
  }
  const { error } = await context.supabase.rpc("set_member_permissions", {
    p_org: orgId,
    p_user: userId,
    p_permissions: [...new Set([...kept, ...ticked])],
  });
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו לשמור את ההרשאות. נסו שוב."));
  revalidatePath(memberPermissionsPath(orgId, userId));
  revalidatePath(paths.settingsUsers(orgId));
  return { ok: true, message: "ההרשאות נשמרו." };
}
