import "server-only";

import { must } from "@/lib/db-read";
import { formatNumber } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { parseReportData } from "@/features/reports/schemas";

import { stuckReason, type StuckInfo, type StuckRow } from "./stuck-text";

/**
 * Open deals of a pipeline that need attention: stuck (longer in their stage than the stage
 * allows, 14 days by default, and not postponed), postponed instead of stuck, or with no open
 * task and no planned meeting.
 * Read through report_stuck_deals, security invoker: the user sees only deals they may see.
 */
export async function getStuckDeals(orgId: string, pipelineId: string): Promise<Record<string, StuckInfo>> {
  const supabase = await createClient();
  const raw = must(await supabase.rpc("report_stuck_deals", { p_org: orgId, p_pipeline: pipelineId }), "stuck deals");
  // FXC-12: the result is checked before it is read; a mismatch throws (the page's error screen)
  parseReportData("report_stuck_deals", raw);
  const rows = raw as StuckRow[] | null;
  return Object.fromEntries((rows ?? []).map((row) => [row.id, { stuck: row.stuck === true, postponed: row.postponed === true, noNextStep: row.no_next_step === true, text: stuckReason(row, formatNumber) }]));
}
