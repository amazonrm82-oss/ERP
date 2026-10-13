"use server";

import { redirect } from "next/navigation";

import { actionContext } from "@/lib/action-context";
import { fail, type ActionResult } from "@/lib/action-result";
import { paths } from "@/lib/paths";

/**
 * Owner's answer of 13 October 2026 ("עזיבת עסק מושהה או מבוטל"): a member who is not the owner
 * leaves a business closed until payment. The database checks everything (public.leave_closed_organization).
 */
export async function leaveClosedOrganizationAction(orgId: string): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const { error } = await context.supabase.rpc("leave_closed_organization", { p_org: orgId });
  if (error) {
    return fail(error.hint === "leave:open" ? "העסק פעיל שוב. רעננו את הדף." : "לא הצלחנו להוציא אתכם מהעסק. נסו שוב.");
  }
  redirect(paths.home);
}
