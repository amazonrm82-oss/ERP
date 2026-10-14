import "server-only";

import { formValues } from "@/lib/action-result";
import type { Json } from "@/lib/database.types";
import { dbErrorMessage } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";

import { BUILTIN_CONDITION_FIELDS, hasConditions, missingRequiredAfter } from "./conditions";
import { listFieldDefinitions } from "./queries";
import { requiredAnswer, type MoveRefusal } from "./required-move";
import { asCustomValues, type FieldDefinition } from "./types";

// FLD-09 (owner, 14 October 2026): a conditionally required field outside the record form. Every move by
// hand (board, table cell, the lead's status form, the deal's stage menu, the won window) asks for the
// missing values and saves them with the move (requiredForMove, used by moveRecord in
// src/features/record-move/); a bulk action skips the record. App-only, like "required": the database
// never refuses.

export type MoveObject = "lead" | "deal";

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
 * The one check of a move by hand (FLD-09): the fields the new status or stage leaves required and
 * empty, against what the form sent (requiredAnswer). ok with {"$merge": …} for the same update as the
 * move (undefined when nothing is missing); a MoveRefusal that names the fields; or a read error.
 */
export async function requiredForMove(
  orgId: string,
  object: MoveObject,
  id: string,
  change: Record<string, string | null>,
  formData: FormData | null,
): Promise<{ ok: true; merge: Json | undefined } | MoveRefusal | { ok: false; message: string }> {
  const found = await missingAfterChange(orgId, object, [id], change);
  if (!found.ok) return { ok: false, message: dbErrorMessage(found.error, "לא הצלחנו לבדוק את שדות החובה. נסו שוב.") };
  const answer = requiredAnswer(found.missing.get(id) ?? [], formData, formData ? formValues(formData) : undefined);
  if (!answer.ok) return answer;
  return { ok: true, merge: answer.patch === undefined ? undefined : { $merge: answer.patch } };
}
