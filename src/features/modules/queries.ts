import "server-only";

import { cache } from "react";

import { createClient } from "@/lib/supabase/server";

import { DEFAULT_MODULES, modulesFromRow, type OrgModules } from "./modules";

/**
 * LEAD-08: which modules the business uses, read once per request with the user's session. A failed read is "both on"
 * (and orders off): the switch only hides screens (RLS decides what anyone reads), so failing shows the business as it was.
 */
export const getOrgModules = cache(async (orgId: string): Promise<OrgModules> => {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.from("org_modules").select("leads_enabled, companies_enabled, orders_enabled, orders_offer_closed_at").eq("organization_id", orgId).maybeSingle();
    return error ? DEFAULT_MODULES : modulesFromRow(data);
  } catch {
    return DEFAULT_MODULES;
  }
});
