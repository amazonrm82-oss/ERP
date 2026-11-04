import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { PUNCH_REPORT_PREFERENCE, punchDaysFromColumns, type PunchDays } from "./punch-days";

/** PKG-07 (owner (117) ב): the signed-in user's "expiring" window for this business (own row under RLS), else 30. */
export async function getPunchReportDays(orgId: string): Promise<PunchDays> {
  const supabase = await createClient();
  const data = must(
    await supabase.from("list_preferences").select("columns").eq("organization_id", orgId).eq("object_type", PUNCH_REPORT_PREFERENCE).maybeSingle(),
    "list_preferences",
  );
  return punchDaysFromColumns(data?.columns ?? null);
}
