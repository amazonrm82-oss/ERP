import "server-only";

import { listMembers } from "@/features/settings/queries";
import { createClient } from "@/lib/supabase/server";

import { parseCondition } from "./conditions";
import { parseOptionColors } from "./status-colors";
import { isFieldType, isLinkTarget, type FieldDefinition, type FieldObject } from "./types";

/** Custom field definitions of one object type, in order. Active ones only unless asked. */
export async function listFieldDefinitions(
  orgId: string,
  objectType: FieldObject,
  options: { includeInactive?: boolean } = {},
): Promise<FieldDefinition[]> {
  const supabase = await createClient();
  let query = supabase
    .from("field_definitions")
    .select("id, key, label, field_type, options, is_required, is_active, help_text, position, is_unique, is_read_only, default_value, condition, condition_removed_at, option_colors, link_target")
    .eq("organization_id", orgId)
    .eq("object_type", objectType);
  if (!options.includeInactive) {
    query = query.eq("is_active", true);
  }
  const { data, error } = await query.order("position", { ascending: true }).order("created_at", { ascending: true });
  if (error) {
    throw new Error(`field definitions query failed: ${error.message}`);
  }
  const definitions: FieldDefinition[] = data
    .filter((row) => isFieldType(row.field_type))
    .map((row) => {
      const options = Array.isArray(row.options) ? row.options.filter((o): o is string => typeof o === "string") : [];
      return {
      id: row.id,
      key: row.key,
      label: row.label,
      type: row.field_type as FieldDefinition["type"],
      options,
      ...(row.field_type === "status" ? { optionColors: parseOptionColors(row.option_colors, options) } : {}),
      isRequired: row.is_required,
      isActive: row.is_active,
      helpText: row.help_text,
      isUnique: row.is_unique,
      isReadOnly: row.is_read_only,
      defaultValue: row.default_value,
      condition: parseCondition(row.condition),
      conditionRemovedAt: row.condition_removed_at,
      // FLD-06 part B
      ...(row.field_type === "record_link" ? { linkTarget: isLinkTarget(row.link_target) ? row.link_target : null } : {}),
      ...(row.field_type === "record_link" || row.field_type === "file" ? { orgId } : {}),
      };
    });
  // a "user" field picks one of the business's members (FLD-01); a former member keeps their name
  if (definitions.some((field) => field.type === "user")) {
    const members = await listMembers(orgId);
    const choices = members.map((m) => ({ value: m.userId, label: m.status === "active" ? m.name : `${m.name} (לא פעיל)` }));
    for (const field of definitions) if (field.type === "user") field.choices = choices;
  }
  return definitions;
}
