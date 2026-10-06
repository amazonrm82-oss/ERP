import "server-only";

import type { ViewScope } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";

import { cleanFilters, type ViewFilters, type ViewObject } from "./types";

export type SavedView = { id: string; name: string; scope: ViewScope; ownerId: string; filters: ViewFilters };

/** Views of a list the user may see (their own, and the organization's shared ones), by name. */
export async function listSavedViews(orgId: string, objectType: ViewObject): Promise<SavedView[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("saved_views")
    .select("id, name, scope, owner_id, config")
    .eq("organization_id", orgId)
    .eq("object_type", objectType)
    .order("name", { ascending: true });
  if (error) {
    throw new Error(`saved views query failed: ${error.message}`);
  }
  return data.map((row) => {
    const config = row.config && typeof row.config === "object" && !Array.isArray(row.config) ? row.config : {};
    const filters = config.filters && typeof config.filters === "object" && !Array.isArray(config.filters) ? config.filters : {};
    return { id: row.id, name: row.name, scope: row.scope, ownerId: row.owner_id, filters: cleanFilters(filters) };
  });
}
