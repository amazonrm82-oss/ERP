import "server-only";

import { listContactOptions } from "@/features/contacts/queries";
import { BUILTIN_PREFIX, splitMovePatch, stageFieldMissing, stageRequiredDefinition, stageRequiredFields, type StageRequiredField } from "@/features/deals/stage-required";
import { isUuid } from "@/lib/paths";
import { formValues } from "@/lib/action-result";
import type { Json } from "@/lib/database.types";
import { dbErrorMessage } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";

import { BUILTIN_CONDITION_FIELDS, hasConditions, missingRequiredAfter } from "./conditions";
import { listFieldDefinitions } from "./queries";
import { requiredAnswer, type MoveRefusal } from "./required-move";
import { asCustomValues, inputName, type FieldDefinition } from "./types";

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
  // DEAL-05: built-in fields the place asks for itself (the won window's amount)
  exclude: readonly StageRequiredField[] = [],
): Promise<{ ok: true; missing: Map<string, FieldDefinition[]> } | { ok: false; error: unknown }> {
  const missing = new Map<string, FieldDefinition[]>();
  if (ids.length === 0) return { ok: true, missing };
  const definitions = await listFieldDefinitions(orgId, object);
  const supabase = await createClient();
  // a deal's pipeline follows its stage (FLD-09 follow-up): a pipeline condition reads the target stage's pipeline;
  // DEAL-05: the stage's own required built-in fields come with it
  const stageId = change["builtin:stage"];
  let stageRequired: StageRequiredField[] = [];
  if (object === "deal" && typeof stageId === "string") {
    const { data: stage, error: stageError } = await supabase
      .from("stages")
      .select("pipeline_id, required_fields")
      .eq("organization_id", orgId)
      .eq("id", stageId)
      .maybeSingle();
    if (stageError) return { ok: false, error: stageError };
    if (stage && !("builtin:pipeline" in change)) change = { ...change, "builtin:pipeline": stage.pipeline_id };
    stageRequired = stageRequiredFields(stage?.required_fields).filter((field) => !exclude.includes(field));
  }
  if (stageRequired.length > 0) {
    const found = await missingStageFields(supabase, orgId, ids, stageRequired);
    if (!found.ok) return found;
    for (const [id, fields] of found.missing) missing.set(id, fields);
  }
  if (!hasConditions(definitions, object)) return { ok: true, missing };
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
    // DEAL-05: the stage's built-in fields first, then the custom ones
    if (fields.length > 0) missing.set(String(raw.id), [...(missing.get(String(raw.id)) ?? []), ...fields]);
  }
  return { ok: true, missing };
}

/**
 * DEAL-05: per deal id, the built-in fields the target stage requires and the deal leaves empty, as definitions
 * the move asks for (the contact as a choice from the business's contacts, read only when one is missing).
 */
async function missingStageFields(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  ids: string[],
  required: StageRequiredField[],
): Promise<{ ok: true; missing: Map<string, FieldDefinition[]> } | { ok: false; error: unknown }> {
  const missing = new Map<string, FieldDefinition[]>();
  const { data, error } = await supabase
    .from("deals")
    .select("id, amount_agorot, expected_close_date, contact_id")
    .eq("organization_id", orgId)
    .in("id", ids.slice(0, 1000));
  if (error) return { ok: false, error };
  const empty = new Map<string, StageRequiredField[]>();
  for (const deal of data ?? []) {
    const fields = required.filter((field) => stageFieldMissing(field, deal));
    if (fields.length > 0) empty.set(deal.id, fields);
  }
  if (empty.size === 0) return { ok: true, missing };
  let contacts: Array<{ id: string; name: string }> = [];
  if ([...empty.values()].some((fields) => fields.includes("contact_id"))) {
    try {
      contacts = await listContactOptions(orgId);
    } catch (readError) {
      return { ok: false, error: readError };
    }
  }
  for (const [id, fields] of empty) missing.set(id, fields.map((field) => stageRequiredDefinition(field, contacts)));
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
  exclude: readonly StageRequiredField[] = [],
): Promise<{ ok: true; merge: Json | undefined; columns: Record<string, Json> | undefined } | MoveRefusal | { ok: false; message: string }> {
  const found = await missingAfterChange(orgId, object, [id], change, exclude);
  if (!found.ok) return { ok: false, message: dbErrorMessage(found.error, "לא הצלחנו לבדוק את שדות החובה. נסו שוב.") };
  const fields = await withSentContact(orgId, found.missing.get(id) ?? [], formData);
  if (!fields.ok) return { ok: false, message: dbErrorMessage(fields.error, "לא הצלחנו לבדוק את שדות החובה. נסו שוב.") };
  const answer = requiredAnswer(fields.fields, formData, formData ? formValues(formData) : undefined);
  if (!answer.ok) return answer;
  // DEAL-05: the stage's built-in fields go to the deal's own columns, in the same update
  const { columns, custom } = splitMovePatch(answer.patch);
  return { ok: true, merge: custom === undefined ? undefined : { $merge: custom }, columns };
}

/**
 * DEAL-05 review: the list of contacts a move offers holds the newest 200 only, so the contact the form sent is judged
 * by whether the person may read it in this business and it is not in the bin (one read with the user's session), not
 * by the list. A readable one joins the field's choices, so the shared parsing accepts it; any other stays refused.
 */
async function withSentContact(
  orgId: string,
  fields: FieldDefinition[],
  formData: FormData | null,
): Promise<{ ok: true; fields: FieldDefinition[] } | { ok: false; error: unknown }> {
  const key = `${BUILTIN_PREFIX}contact_id`;
  const field = fields.find((candidate) => candidate.key === key);
  const sent = formData?.get(inputName(key));
  if (!field || typeof sent !== "string" || !isUuid(sent.trim()) || (field.choices ?? []).some((choice) => choice.value === sent.trim())) {
    return { ok: true, fields };
  }
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contacts")
    .select("id, full_name")
    .eq("organization_id", orgId)
    .eq("id", sent.trim())
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return { ok: false, error };
  if (!data) return { ok: true, fields };
  const widened = { ...field, choices: [...(field.choices ?? []), { value: data.id, label: data.full_name ?? "" }] };
  return { ok: true, fields: fields.map((candidate) => (candidate.key === key ? widened : candidate)) };
}
