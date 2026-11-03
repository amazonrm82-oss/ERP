import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

/**
 * PRK-06: the business's privacy officer (user id), read with the user's session (every member reads it).
 * Null when none is set. The mark gives no rights on data: nothing reads it to decide access.
 */
export async function getPrivacyOfficerId(orgId: string): Promise<string | null> {
  const supabase = await createClient();
  const row = must(
    await supabase.from("org_privacy_settings").select("privacy_officer_id").eq("organization_id", orgId).maybeSingle(),
    "privacy settings",
  );
  return row?.privacy_officer_id ?? null;
}
