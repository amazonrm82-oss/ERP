import "server-only";

import { FORM_INVALID } from "@/lib/action-result";
import type { Json } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";

import { BUILTIN_CONDITION_FIELDS, hasConditions, missingRequiredAfter } from "./conditions";
import { listFieldDefinitions } from "./queries";
import { asCustomValues, type FieldDefinition } from "./types";
import { parseCustomFields } from "./values";

// FLD-09 (owner, 14 October 2026): a conditionally required field outside the record form. A move on
// the board or in a table cell asks for the missing values and saves them with the move; a bulk action
// skips the record. App-only, like "required": the database never refuses.

export type MoveObject = "lead" | "deal";

/** The field as the window asks for it: required, without its condition. */
export function askedField(field: FieldDefinition): FieldDefinition {
  return { ...field, isRequired: true, isReadOnly: false, condition: null };
}

/**
 * Per record id, the fields the change would leave required and empty (only ids with some). Read with
 * the user's session; a record the user cannot read is not in the answer (its update finds nothing).
 */
export async function missingAfterChange(
  orgId: string,
  object: MoveObject,
  ids: string[],
  change: Record<string, string | null>,
): Promise<{ ok: true; missing: Map<string, FieldDefinition[]> } | { ok: false; error: unknown }> {
  const missing = new Map<string, FieldDefinition[]>();
  const definitions = await listFieldDefinitions(orgId, object);
  if (ids.length === 0 || !hasConditions(definitions, object)) return { ok: true, missing };
  const supabase = await createClient();
  const columns = BUILTIN_CONDITION_FIELDS[object].map((field) => field.input);
  const table = object === "lead" ? "leads" : "deals";
  // callers pass one record, or a bulk action's page (at most 100 ids): one read
  const { data, error } = await supabase
    .from(table)
    .select(["id", "custom_fields", ...columns].join(", "))
    .eq("organization_id", orgId)
    .in("id", ids.slice(0, 1000));
  if (error) return { ok: false, error };
  for (const raw of (data ?? []) as unknown as Array<Record<string, Json>>) {
    const values: Record<string, Json | undefined> = { ...asCustomValues(raw.custom_fields ?? null) };
    for (const builtin of BUILTIN_CONDITION_FIELDS[object]) {
      const value = raw[builtin.input];
      values[builtin.key] = typeof value === "string" ? value : null;
    }
    const fields = missingRequiredAfter(definitions, values, object, change);
    if (fields.length > 0) missing.set(String(raw.id), fields);
  }
  return { ok: true, missing };
}

/**
 * The values the window sent for the fields the change leaves missing, as {"$merge": …} for the same
 * update as the move. ok with no merge when nothing is missing (any more).
 */
export async function requiredFieldsMerge(
  orgId: string,
  object: MoveObject,
  id: string,
  change: Record<string, string | null>,
  formData: FormData,
): Promise<
  | { ok: true; merge: Json | undefined; missing: FieldDefinition[] }
  | { ok: false; message: string; fieldErrors?: Record<string, string>; missing: FieldDefinition[] }
> {
  const found = await missingAfterChange(orgId, object, [id], change);
  if (!found.ok) return { ok: false, message: "לא הצלחנו לבדוק את שדות החובה. נסו שוב.", missing: [] };
  const fields = (found.missing.get(id) ?? []).map(askedField);
  if (fields.length === 0) return { ok: true, merge: undefined, missing: [] };
  const { values, errors } = parseCustomFields(fields, formData);
  if (Object.keys(errors).length > 0) return { ok: false, message: FORM_INVALID, fieldErrors: errors, missing: fields };
  const patch: Record<string, Json> = {};
  for (const field of fields) {
    const value = values[field.key];
    if (value !== undefined) patch[field.key] = value;
  }
  return { ok: true, merge: { $merge: patch }, missing: [] };
}
