"use server";

import { revalidatePath } from "next/cache";

import { fail, type ActionResult } from "@/lib/action-result";
import { sessionCheck } from "@/lib/auth";
import { dbErrorMessage, SESSION_EXPIRED } from "@/lib/errors";
import { isUuid, paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

import { LATEST_WHATS_NEW } from "./entries";

/** USR-12: the person opened "what's new": the dot goes until a newer entry arrives. Their own row only. */
export async function markWhatsNewSeenAction(orgId: string): Promise<ActionResult> {
  if (!isUuid(orgId)) return fail(SESSION_EXPIRED);
  const session = await sessionCheck();
  if (!session.ok) return fail(session.message);
  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({ whats_new_seen_on: LATEST_WHATS_NEW })
    .eq("id", session.user.id)
    .or(`whats_new_seen_on.is.null,whats_new_seen_on.lt.${LATEST_WHATS_NEW}`)
    .select("id");
  if (error) return fail(dbErrorMessage(error));
  revalidatePath(paths.org(orgId), "layout");
  return { ok: true };
}
