import "server-only";

import { createClient } from "@/lib/supabase/server";

import { manualRulesOf, type ManualEntity, type ManualRule } from "./manual";
import { serverLog } from "@/lib/log-server";

/**
 * AUT-03: the manual rules this person may run on the record (none when they may not edit it). A failed read hides the
 * button instead of breaking the record page.
 */
export async function listManualAutomations(orgId: string, entity: ManualEntity, recordId: string): Promise<ManualRule[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("manual_automations", { p_org: orgId, p_entity: entity, p_record: recordId });
  if (error) {
    await serverLog("error", "automations.manual_read_failed", { code: error.code, error: error.message });
    return [];
  }
  return manualRulesOf(data);
}
