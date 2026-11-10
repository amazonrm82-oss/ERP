import "server-only";

import { createClient } from "@/lib/supabase/server";

import { CLEANUP_LIST_LIMIT, cleanupLoadMessage, cleanupSchema, type CleanupAnswer } from "./cleanup";
import { serverLog } from "@/lib/log-server";

export type CleanupRead = { ok: true; answer: CleanupAnswer } | { ok: false; message: string };

/**
 * DQL-03: the four cleanup groups, read with the user's session (only what the user may see is counted). A database error
 * (a statement timeout on a large business included) or an answer of the wrong shape comes back as a Hebrew line, logged
 * with its code only.
 */
export async function getCleanupSuggestions(orgId: string, limit = CLEANUP_LIST_LIMIT): Promise<CleanupRead> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("cleanup_suggestions", { p_org: orgId, p_limit: limit });
  if (error) {
    await serverLog("error", "cleanup_suggestions.read_failed", { org_id: orgId, code: error.code ?? "unknown" });
    return { ok: false, message: cleanupLoadMessage(error) };
  }
  const parsed = cleanupSchema.safeParse(data);
  if (!parsed.success) {
    await serverLog("error", "cleanup_suggestions.shape", { org_id: orgId });
    return { ok: false, message: cleanupLoadMessage(null) };
  }
  return { ok: true, answer: parsed.data };
}
