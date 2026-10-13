import "server-only";

import { z } from "zod";

import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import {
  completenessCatalog,
  completenessLabel,
  COMPLETENESS_TYPES,
  formFieldFor,
  type CompletenessField,
  type CompletenessType,
} from "./completeness";

export type MissingField = { key: string; label: string; formField: string | null };
export type RecordScore = { score: number; missing: MissingField[] };

const scoredSchema = z.array(z.object({ id: z.string(), score: z.number().int(), missing: z.array(z.string()) }));
const incompleteSchema = z.object({
  total: z.number().int(),
  rows: z.array(z.object({ id: z.string(), name: z.string().nullable(), score: z.number().int(), missing: z.array(z.string()) })),
});

/** The catalog of one type: built-in fields and the type's active custom fields. */
export async function completenessCatalogFor(orgId: string, type: CompletenessType): Promise<CompletenessField[]> {
  return completenessCatalog(type, await listFieldDefinitions(orgId, type));
}

/** The important keys per type, as saved (a type without a row has none). */
export async function getCompletenessSettings(orgId: string): Promise<Record<CompletenessType, string[]>> {
  const supabase = await createClient();
  const rows = must(
    await supabase.from("completeness_settings").select("object_type, fields").eq("organization_id", orgId),
    "completeness settings",
  );
  const result = Object.fromEntries(COMPLETENESS_TYPES.map((type) => [type, [] as string[]])) as Record<CompletenessType, string[]>;
  for (const row of rows) {
    if ((COMPLETENESS_TYPES as readonly string[]).includes(row.object_type)) {
      result[row.object_type as CompletenessType] = row.fields;
    }
  }
  return result;
}

function describe(type: CompletenessType, catalog: CompletenessField[], keys: string[]): MissingField[] {
  return keys.map((key) => ({ key, label: completenessLabel(catalog, key) ?? key, formField: formFieldFor(type, key) }));
}

/** Score and missing fields of the given records the user can read (others are left out). */
export async function getScores(orgId: string, type: CompletenessType, ids: string[], catalog?: CompletenessField[]): Promise<Map<string, RecordScore>> {
  if (ids.length === 0) {
    return new Map();
  }
  const supabase = await createClient();
  const [data, fields] = await Promise.all([
    supabase.rpc("record_completeness", { p_org: orgId, p_type: type, p_ids: ids.slice(0, 200) }).then((res) => must(res, "record completeness")),
    catalog ? Promise.resolve(catalog) : completenessCatalogFor(orgId, type),
  ]);
  const rows = scoredSchema.parse(data);
  return new Map(rows.map((row) => [row.id, { score: row.score, missing: describe(type, fields, row.missing) }]));
}

/** One record's score, or null when the user cannot read it. */
export async function getRecordScore(orgId: string, type: CompletenessType, id: string): Promise<RecordScore | null> {
  return (await getScores(orgId, type, [id])).get(id) ?? null;
}

export type IncompleteList = { total: number; rows: Array<{ id: string; name: string | null; score: number; missing: MissingField[] }> };

/** A person's live records of one type under 100%, worst first (RLS decides what is counted). */
export async function listIncomplete(orgId: string, type: CompletenessType, ownerId: string, limit = 50): Promise<IncompleteList> {
  const supabase = await createClient();
  const [data, catalog] = await Promise.all([
    supabase.rpc("incomplete_records", { p_org: orgId, p_type: type, p_owner: ownerId, p_limit: limit }).then((res) => must(res, "incomplete records")),
    completenessCatalogFor(orgId, type),
  ]);
  const parsed = incompleteSchema.parse(data);
  return { total: parsed.total, rows: parsed.rows.map((row) => ({ ...row, missing: describe(type, catalog, row.missing) })) };
}

/** Just the scores (0..100) of many records, 200 at a time: the list column and the list export. */
export async function getScoreNumbers(orgId: string, type: CompletenessType, ids: string[]): Promise<Map<string, number>> {
  const supabase = await createClient();
  const result = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 200) {
    const data = must(await supabase.rpc("record_completeness", { p_org: orgId, p_type: type, p_ids: ids.slice(i, i + 200) }), "record completeness");
    for (const row of scoredSchema.parse(data)) {
      result.set(row.id, row.score);
    }
  }
  return result;
}
