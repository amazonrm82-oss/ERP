import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { fail } from "@/lib/action-result";
import { getSessionUser, type SessionUser } from "@/lib/auth";
import type { Database } from "@/lib/database.types";
import { NOT_FOUND, SESSION_EXPIRED } from "@/lib/errors";
import { isUuid } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

type ActionContext =
  | { ok: true; supabase: SupabaseClient<Database>; user: SessionUser }
  | ReturnType<typeof fail>;

/**
 * First lines of every org-scoped Server Action: the caller must be signed in
 * and every id must look like a uuid (ids arrive from the client, bound into
 * the action). Whether the user may touch the organization or the record is
 * decided by RLS when the query runs.
 */
export async function actionContext(orgId: string, ...recordIds: string[]): Promise<ActionContext> {
  if (![orgId, ...recordIds].every(isUuid)) {
    return fail(NOT_FOUND);
  }
  const user = await getSessionUser();
  if (!user) {
    return fail(SESSION_EXPIRED);
  }
  return { ok: true, supabase: await createClient(), user };
}
