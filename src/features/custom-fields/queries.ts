import "server-only";

import { createClient } from "@/lib/supabase/server";

import { isFieldType, type FieldDefinition, type FieldObject } from "./types";

/** Custom field definitions of one object type, in order. Active ones only unless asked. */
export async function listFieldDefinitions(
  orgId: string,
  objectType: FieldObject,
  options: { includeInactive?: boolean } = {},
): Promise<FieldDefinition[]> {
  const supabase = await createClient();
  let query = supabase
    .from("field_definitions")
    .select("id, key, label, field_type, options, is_required, is_active, help_text, position")
    .eq("organization_id", orgId)
    .eq("object_type", objectType);
  if (!options.includeInactive) {
    query = query.eq("is_active", true);
  }
  const { data, error } = await query.order("position", { ascending: true }).order("created_at", { ascending: true });
  if (error) {
    throw new Error(`field definitions query failed: ${error.message}`);
  }
  return data
    .filter((row) => isFieldType(row.field_type))
    .map((row) => ({
      id: row.id,
      key: row.key,
      label: row.label,
      type: row.field_type as FieldDefinition["type"],
      options: Array.isArray(row.options) ? row.options.filter((o): o is string => typeof o === "string") : [],
      isRequired: row.is_required,
      isActive: row.is_active,
      helpText: row.help_text,
    }));
}
