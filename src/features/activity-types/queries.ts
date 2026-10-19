import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { isActivityBase, isActivityTypeIcon, type ActivityTypeOption } from "./types";

/** TASK-08: the business's activity and task types, in the list's order, hidden ones included (members read). */
export async function listActivityTypes(orgId: string): Promise<ActivityTypeOption[]> {
  const supabase = await createClient();
  const rows =
    must(
      await supabase
        .from("activity_types")
        .select("id, base_type, name, icon, key, position, is_active, created_at")
        .eq("organization_id", orgId)
        .order("position", { ascending: true })
        .order("created_at", { ascending: true }),
      "activity types",
    ) ?? [];
  return rows.flatMap((row) =>
    isActivityBase(row.base_type)
      ? [{ id: row.id, baseType: row.base_type, name: row.name, icon: isActivityTypeIcon(row.icon) ? row.icon : null, key: row.key, isActive: row.is_active }]
      : [],
  );
}
