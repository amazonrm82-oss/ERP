import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { fail, ok, type ActionResult } from "@/lib/action-result";
import type { Database } from "@/lib/database.types";
import { dbErrorMessage } from "@/lib/errors";

import { applyResultSchema, type ApplyResult } from "./schema";

const APPLY_FAILED = "לא הצלחנו להחיל את התבנית. נסו שוב.";

/**
 * Applies an industry template with the user's session. The database checks
 * the role and the organization's state, adds only what is missing, and
 * reports what a plan limit left out.
 */
export async function applyTemplate(supabase: SupabaseClient<Database>, orgId: string, industry: string): Promise<ActionResult<ApplyResult>> {
  const { data, error } = await supabase.rpc("apply_industry_template", { p_org: orgId, p_industry: industry });
  if (error) {
    return fail(dbErrorMessage(error, APPLY_FAILED));
  }
  const parsed = applyResultSchema.safeParse(data);
  if (!parsed.success) {
    return fail(APPLY_FAILED);
  }
  return ok(parsed.data);
}
