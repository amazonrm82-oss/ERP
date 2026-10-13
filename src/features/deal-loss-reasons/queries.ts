import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

export type LossReason = { id: string; name: string; position: number; isActive: boolean };

/** Every loss reason of the organization, hidden ones included, in the order the admin set (DEAL-03). */
export async function listLossReasons(orgId: string): Promise<LossReason[]> {
  const supabase = await createClient();
  const rows =
    must(
      await supabase
        .from("deal_loss_reasons")
        .select("id, name, position, is_active, created_at")
        .eq("organization_id", orgId)
        .order("position", { ascending: true })
        .order("created_at", { ascending: true }),
      "deal loss reasons",
    ) ?? [];
  return rows.map((row) => ({ id: row.id, name: row.name, position: row.position, isActive: row.is_active }));
}

export type LossReasonOption = { id: string; name: string };

/** The reasons a person picks from when a deal is lost. */
export function activeLossReasons(reasons: LossReason[]): LossReasonOption[] {
  return reasons.filter((reason) => reason.isActive).map(({ id, name }) => ({ id, name }));
}
