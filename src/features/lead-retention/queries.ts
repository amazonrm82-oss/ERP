import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { RETENTION_PAGE_SIZE } from "./model";
import { retentionRoundSchema, retentionStatusSchema, type RetentionRound, type RetentionStatus } from "./schema";

/** PRV-01: the policy and its rounds (owners and admins; the function refuses anyone else). */
export async function getRetentionStatus(orgId: string): Promise<RetentionStatus> {
  const supabase = await createClient();
  const data = must(await supabase.rpc("lead_retention_status", { p_org: orgId }), "lead retention status");
  return retentionStatusSchema.parse(data);
}

/** PRV-01: one page of the open round's list (page 1 = the first 100). */
export async function getRetentionRound(orgId: string, page: number): Promise<RetentionRound> {
  const supabase = await createClient();
  const data = must(
    await supabase.rpc("lead_retention_round_leads", { p_org: orgId, p_offset: (Math.max(1, page) - 1) * RETENTION_PAGE_SIZE }),
    "lead retention round",
  );
  return retentionRoundSchema.parse(data);
}
