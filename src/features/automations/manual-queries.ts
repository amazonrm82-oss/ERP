import "server-only";

import { createClient } from "@/lib/supabase/server";

import { manualRulesOf, type ManualEntity, type ManualRule } from "./manual";

/**
 * AUT-03: the manual rules this person may run on the record (none when they may not edit it). A failed read hides the
 * button instead of breaking the record page.
 */
export async function listManualAutomations(orgId: string, entity: ManualEntity, recordId: string): Promise<ManualRule[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("manual_automations", { p_org: orgId, p_entity: entity, p_record: recordId });
  if (error) {
    console.error(`manual automations read failed: ${error.message}`);
    return [];
  }
  return manualRulesOf(data);
}
