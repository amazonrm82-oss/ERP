import "server-only";

import { must } from "@/lib/db-read";
import { formatNumber } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { parseReportData } from "@/features/reports/schemas";

import { stuckReason, type StuckInfo, type StuckRow } from "./stuck-text";

// deal ids per call of public.deal_attention (the request body stays small; the board shows at most a few hundred)
const ATTENTION_SLICE = 500;

/**
 * Open deals among `dealIds` that need attention: stuck (longer in their stage than the stage
 * allows, 14 days by default, and not postponed), postponed instead of stuck, or with no open
 * task and no planned meeting. Read through public.deal_attention (security invoker, so the user
 * sees only deals they may see), which shares its rule with report_stuck_deals but has no 200-row
 * cap: every deal the board shows gets its mark (DEAL-02).
 */
export async function getDealAttention(orgId: string, dealIds: string[]): Promise<Record<string, StuckInfo>> {
  const ids = [...new Set(dealIds)];
  if (ids.length === 0) return {};
  const supabase = await createClient();
  const slices: string[][] = [];
  for (let i = 0; i < ids.length; i += ATTENTION_SLICE) slices.push(ids.slice(i, i + ATTENTION_SLICE));
  const results = await Promise.all(slices.map((slice) => supabase.rpc("deal_attention", { p_org: orgId, p_deals: slice })));
  const out: Record<string, StuckInfo> = {};
  for (const result of results) {
    const raw = must(result, "deal attention");
    // FXC-12: the rows have report_stuck_deals' shape; a mismatch throws (the page's error screen)
    parseReportData("report_stuck_deals", raw);
    for (const row of (raw as StuckRow[] | null) ?? []) {
      out[row.id] = { stuck: row.stuck === true, postponed: row.postponed === true, noNextStep: row.no_next_step === true, text: stuckReason(row, formatNumber) };
    }
  }
  return out;
}
