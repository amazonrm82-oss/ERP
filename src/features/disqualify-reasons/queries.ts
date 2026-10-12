import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

export type DisqualifyReason = { id: string; name: string; position: number; isActive: boolean };

/** Every reason of the organization, hidden ones included, in the order the admin set. */
export async function listDisqualifyReasons(orgId: string): Promise<DisqualifyReason[]> {
  const supabase = await createClient();
  const rows =
    must(
      await supabase
        .from("disqualify_reasons")
        .select("id, name, position, is_active, created_at")
        .eq("organization_id", orgId)
        .order("position", { ascending: true })
        .order("created_at", { ascending: true }),
      "disqualify reasons",
    ) ?? [];
  return rows.map((row) => ({ id: row.id, name: row.name, position: row.position, isActive: row.is_active }));
}

/**
 * The names a person picks from when a lead is not relevant. Empty while the
 * organization has none: then any reason is accepted, as before (LEAD-03).
 */
export async function activeReasonNames(orgId: string): Promise<string[]> {
  return (await listDisqualifyReasons(orgId)).filter((reason) => reason.isActive).map((reason) => reason.name);
}
