import "server-only";

import { createClient } from "@/lib/supabase/server";

import { parseSystemBanners, type SystemBanner } from "./banners";

/**
 * ADM-04: the banners this business shows the signed-in person now. Cosmetic: a failed read shows none and never takes
 * the business shell down.
 */
export async function getSystemBanners(orgId: string): Promise<SystemBanner[]> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("system_banners_for", { p_org: orgId });
    if (error) return [];
    return parseSystemBanners(data);
  } catch {
    return [];
  }
}
