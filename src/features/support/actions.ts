"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";

const HOURS = [1, 24, 72] as const;

/** The owner or an admin lets platform support see the organization, read-only, for a while. */
export async function grantSupportAccessAction(orgId: string, hours: number): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  if (!HOURS.includes(hours as (typeof HOURS)[number])) return fail("משך הגישה אינו תקין.");
  const { error } = await context.supabase
    .from("support_access_grants")
    .insert({ organization_id: orgId, expires_at: new Date(Date.now() + hours * 3_600_000).toISOString() });
  if (error) {
    return fail(error.code === "42501" ? "רק בעלים ומנהלי מערכת יכולים לאשר גישת תמיכה." : dbErrorMessage(error, "לא הצלחנו לאשר את הגישה."));
  }
  revalidatePath(paths.settings(orgId));
  return ok();
}

export async function revokeSupportAccessAction(orgId: string): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("support_access_grants")
    .update({ revoked_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("id");
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו לבטל את הגישה."));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(paths.settings(orgId));
  return ok();
}
