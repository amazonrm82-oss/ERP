"use server";

import { fail, type ActionResult } from "@/lib/action-result";
import { sessionCheck } from "@/lib/auth";
import { dbErrorMessage, SESSION_EXPIRED } from "@/lib/errors";
import { isUuid } from "@/lib/paths";
import { getOrgContextAllowClosed } from "@/features/shell/queries";
import { createClient } from "@/lib/supabase/server";

import { tourMarksSeen } from "./tour";

/**
 * UX-05: the person finished or skipped the first-visit tour; it does not open by itself again. Their own row only
 * (column grant), and only the first time (a replay from the account menu changes nothing). A support session writes
 * nothing: staff only look.
 */
export async function markGuideTourSeenAction(orgId: string): Promise<ActionResult> {
  if (!isUuid(orgId)) return fail(SESSION_EXPIRED);
  const session = await sessionCheck();
  if (!session.ok) return fail(session.message);
  const context = await getOrgContextAllowClosed(orgId);
  if (!tourMarksSeen(context.supportUntil !== null)) return { ok: true };
  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({ guide_tour_seen_at: new Date().toISOString() })
    .eq("id", session.user.id)
    .is("guide_tour_seen_at", null)
    .select("id");
  if (error) return fail(dbErrorMessage(error));
  return { ok: true };
}
