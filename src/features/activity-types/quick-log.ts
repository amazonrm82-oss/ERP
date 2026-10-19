import "server-only";

import type { createClient } from "@/lib/supabase/server";

import { quickLogTypeId, type ActivityBase } from "./types";

type Client = Awaited<ReturnType<typeof createClient>>;

/**
 * TASK-08 follow-up: the type a one-step log records (quickLogTypeId), read with the user's session. Never in the way of
 * the log: a failed read is "no type", and the entry is logged with its kind alone.
 */
export async function quickLogType(supabase: Client, orgId: string, base: ActivityBase): Promise<string | null> {
  const { data, error } = await supabase
    .from("activity_types")
    .select("id, base_type, key, is_active")
    .eq("organization_id", orgId)
    .eq("base_type", base)
    .eq("is_active", true)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error || !data) return null;
  return quickLogTypeId(
    base,
    data.map((row) => ({ id: row.id, baseType: base, key: row.key, isActive: row.is_active })),
  );
}

/** Whether an insert was refused only because of the picked type (it was hidden or removed meanwhile). */
export function typeRefused(error: { hint?: string | null } | null): boolean {
  return error?.hint === "activity_type:invalid";
}
