import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";

// FXD-07: the managed lists whose order is saved in one database call (public.reorder_positions; its closed list of
// tables must hold every name here)
export type ReorderTable =
  | "stages"
  | "lead_statuses"
  | "field_definitions"
  | "disqualify_reasons"
  | "deal_loss_reasons"
  | "record_type_options"
  | "whatsapp_templates"
  | "product_categories"
  | "product_units"
  | "deal_contact_roles"
  | "lead_routing_rules"
  | "contact_relation_types";

/**
 * Saves a list's order (positions 0..n-1) in one call: all of it or none of it, with the user's rights. Answers an
 * error message, or null.
 */
export async function saveOrder(supabase: SupabaseClient<Database>, table: ReorderTable, orgId: string, ids: string[]): Promise<string | null> {
  const { error } = await supabase.rpc("reorder_positions", { p_table: table, p_org: orgId, p_ids: ids });
  if (!error) return null;
  return error.code === "42501" ? NOT_FOUND_OR_FORBIDDEN : dbErrorMessage(error);
}
