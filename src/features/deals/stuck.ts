import "server-only";

import { must } from "@/lib/db-read";
import { formatNumber } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

type StuckRow = { id: string; idle: boolean; idle_days: number; no_next_step: boolean };

/** Why an open deal is stuck, in words; the board and the deal page show it (DEAL-02). */
export function stuckReason(row: Pick<StuckRow, "idle" | "idle_days" | "no_next_step">): string {
  const parts: string[] = [];
  if (row.idle) parts.push(row.idle_days === 1 ? "בלי פעילות יום אחד" : `בלי פעילות ${formatNumber(row.idle_days)} ימים`);
  if (row.no_next_step) parts.push("אין משימה פתוחה");
  return parts.join(" · ");
}

/**
 * Open deals of a pipeline that are stuck: idle longer than their stage allows
 * (the stage's days, 14 by default), or with no open task. Read through
 * report_stuck_deals, security invoker: the user sees only deals they may see.
 */
export async function getStuckDeals(orgId: string, pipelineId: string): Promise<Record<string, string>> {
  const supabase = await createClient();
  const rows = must(await supabase.rpc("report_stuck_deals", { p_org: orgId, p_pipeline: pipelineId }), "stuck deals") as StuckRow[] | null;
  return Object.fromEntries((rows ?? []).map((row) => [row.id, stuckReason(row)]));
}
