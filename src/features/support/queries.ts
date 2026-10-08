import "server-only";

import { createClient } from "@/lib/supabase/server";
import { must } from "@/lib/db-read";

/** The open support grant of an organization (admins only; RLS), or null. */
export async function getOpenSupportGrant(orgId: string): Promise<{ id: string; expiresAt: string } | null> {
  const supabase = await createClient();
  const data = must(await supabase
    .from("support_access_grants")
    .select("id, expires_at")
    .eq("organization_id", orgId)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("expires_at", { ascending: false })
    .limit(1)
    .maybeSingle(), "support_access_grants");
  return data ? { id: data.id, expiresAt: data.expires_at } : null;
}
