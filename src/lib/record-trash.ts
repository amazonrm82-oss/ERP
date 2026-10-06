import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { fail, ok, type ActionResult } from "@/lib/action-result";
import type { Database } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";

export type TrashableTable = "leads" | "contacts" | "companies" | "deals";

/**
 * Moves a record to the recycle bin (trash = true) or back out of it.
 * The guard_soft_delete trigger allows this to admins and to managers on their
 * teams' records; for anyone else the update raises 42501.
 */
export async function setTrashed(
  supabase: SupabaseClient<Database>,
  table: TrashableTable,
  orgId: string,
  id: string,
  trash: boolean,
): Promise<ActionResult> {
  const query = supabase
    .from(table as "leads")
    .update({ deleted_at: trash ? new Date().toISOString() : null })
    .eq("organization_id", orgId)
    .eq("id", id);
  const { data, error } = await (trash ? query.is("deleted_at", null) : query.not("deleted_at", "is", null)).select("id");
  if (error) {
    return fail(dbErrorMessage(error, trash ? "לא הצלחנו להעביר לסל המחזור. נסו שוב." : "לא הצלחנו לשחזר. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  return ok();
}
