import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { parseRecordSummary, type RecordSummaryData } from "./summary";

/**
 * REC-10: deals, last touch and next task of a contact or a company, read with the
 * user's session in one call (public.record_summary, security invoker: RLS decides
 * what is counted). A company counts what is linked to it and to its live contacts.
 */
export async function getRecordSummary(orgId: string, type: "contact" | "company", id: string): Promise<RecordSummaryData> {
  const supabase = await createClient();
  const data = must(await supabase.rpc("record_summary", { p_org: orgId, p_type: type, p_id: id }), "record_summary");
  return parseRecordSummary(data);
}
