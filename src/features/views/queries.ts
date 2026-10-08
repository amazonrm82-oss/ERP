import "server-only";

import { columnChoicesSchema } from "@/features/list-columns/columns";
import type { ViewScope } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";

import { cleanFilters, VIEW_SORT_RE, type ViewConfig, type ViewObject } from "./types";

export type SavedView = { id: string; name: string; scope: ViewScope; teamId: string | null; ownerId: string; config: ViewConfig };

function readConfig(raw: unknown): ViewConfig {
  const config = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const filters = config.filters && typeof config.filters === "object" && !Array.isArray(config.filters) ? config.filters : {};
  const sort = typeof config.sort === "string" && VIEW_SORT_RE.test(config.sort) ? config.sort : null;
  const columns = columnChoicesSchema.safeParse(config.columns);
  return { filters: cleanFilters(filters as Record<string, unknown>), sort, columns: columns.success ? columns.data : null };
}

/** Views of a list the user may see (their own, their teams' and the organization's), by name. */
export async function listSavedViews(orgId: string, objectType: ViewObject): Promise<SavedView[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("saved_views")
    .select("id, name, scope, team_id, owner_id, config")
    .eq("organization_id", orgId)
    .eq("object_type", objectType)
    .order("name", { ascending: true });
  if (error) {
    throw new Error(`saved views query failed: ${error.message}`);
  }
  return data.map((row) => ({ id: row.id, name: row.name, scope: row.scope, teamId: row.team_id, ownerId: row.owner_id, config: readConfig(row.config) }));
}

export type ShareTeam = { id: string; name: string };

/** Teams a view can be shared with: the user's own teams, or every team for an admin (as the insert policy allows). */
export async function listShareTeams(orgId: string, userId: string, isAdmin: boolean): Promise<ShareTeam[]> {
  const supabase = await createClient();
  const [teams, mine] = await Promise.all([
    supabase.from("teams").select("id, name").eq("organization_id", orgId).order("name"),
    supabase.from("team_members").select("team_id").eq("organization_id", orgId).eq("user_id", userId),
  ]);
  const own = new Set((mine.data ?? []).map((row) => row.team_id));
  return (teams.data ?? []).filter((team) => isAdmin || own.has(team.id));
}
