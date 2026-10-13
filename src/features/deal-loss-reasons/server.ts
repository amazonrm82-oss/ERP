import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { dbErrorMessage } from "@/lib/errors";

/**
 * DEAL-03: the id of an active loss reason by its name, for the list cell and
 * the bulk bar, which pick by name. An empty name is "no reason" (optional).
 */
export async function lossReasonIdByName(
  supabase: SupabaseClient<Database>,
  orgId: string,
  name: string | null | undefined,
): Promise<{ ok: true; id: string | null } | { ok: false; message: string }> {
  const wanted = name?.trim() ?? "";
  if (!wanted) return { ok: true, id: null };
  const { data, error } = await supabase
    .from("deal_loss_reasons")
    .select("id")
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .eq("name", wanted)
    .maybeSingle();
  if (error) return { ok: false, message: dbErrorMessage(error) };
  if (!data) return { ok: false, message: "יש לבחור סיבה מהרשימה. אם הרשימה השתנתה, רעננו את הדף." };
  return { ok: true, id: data.id };
}
