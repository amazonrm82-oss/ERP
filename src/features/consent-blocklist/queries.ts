import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { blocklistSummarySchema, type BlocklistSummary } from "./schema";

/** CNS-06: counts of the business's blocklist (owners and admins; the function refuses anyone else). */
export async function getBlocklistSummary(orgId: string): Promise<BlocklistSummary> {
  const supabase = await createClient();
  const data = must(await supabase.rpc("consent_blocklist_summary", { p_org: orgId }), "consent blocklist summary");
  return blocklistSummarySchema.parse(data);
}
