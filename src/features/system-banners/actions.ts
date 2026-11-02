"use server";

import { revalidatePath } from "next/cache";

import { fail, type ActionResult } from "@/lib/action-result";
import { sessionCheck } from "@/lib/auth";
import { dbErrorMessage, SESSION_EXPIRED } from "@/lib/errors";
import { isUuid, paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

/** ADM-04: closes a banner for this person, on every device (kept in the database). */
export async function dismissBannerAction(orgId: string, bannerId: string): Promise<ActionResult> {
  if (!isUuid(orgId) || !isUuid(bannerId)) return fail(SESSION_EXPIRED);
  if (!(await sessionCheck()).ok) return fail(SESSION_EXPIRED);
  const supabase = await createClient();
  const { error } = await supabase.rpc("system_banner_dismiss", { p_org: orgId, p_banner: bannerId });
  // a banner that ended meanwhile is gone anyway
  if (error && error.code !== "P0002") return fail(dbErrorMessage(error));
  revalidatePath(paths.org(orgId), "layout");
  return { ok: true };
}
