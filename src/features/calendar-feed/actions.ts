"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { siteOrigin } from "@/lib/site-origin";

import { isFeedToken } from "./ics";
import { calendarFeedPath } from "./paths";

/**
 * CAL-07: a new personal calendar link for this business. The old link (if any)
 * stops working. The address is returned once: only its hash is kept.
 */
export async function createCalendarFeedAction(orgId: string): Promise<ActionResult<{ url: string }>> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("calendar_feed_create", { p_org: orgId });
  if (error) {
    return fail(error.hint === "org:suspended" ? "העסק מושעה כרגע, ולכן אי אפשר ליצור קישור ליומן." : dbErrorMessage(error, "לא הצלחנו ליצור קישור. נסו שוב."));
  }
  if (typeof data !== "string" || !isFeedToken(data)) {
    return fail("לא הצלחנו ליצור קישור. נסו שוב.");
  }
  revalidatePath(paths.settingsAccount(orgId));
  return ok({ url: `${await siteOrigin()}${calendarFeedPath(data)}` });
}

/** Turns the personal calendar link off; the calendar apps stop getting updates. */
export async function revokeCalendarFeedAction(orgId: string): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const { error } = await context.supabase.rpc("calendar_feed_revoke", { p_org: orgId });
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו לבטל את הקישור. נסו שוב."));
  revalidatePath(paths.settingsAccount(orgId));
  return ok();
}
