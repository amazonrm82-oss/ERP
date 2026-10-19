// DEAL-05 (owner, 18 October 2026, answer (א)): the built-in deal fields a stage may require (stages.required_fields).
// They join FLD-09's conditionally required custom fields: every move by hand asks for them, a bulk move skips the
// deal. App-only, like FLD-09. They travel through the same machinery as custom fields, as pseudo-definitions whose
// key starts with "builtin:", and are written to their own columns with the move.

import type { Json } from "@/lib/database.types";

import type { FieldDefinition } from "@/features/custom-fields/types";

export const STAGE_REQUIRED_FIELDS = ["amount", "expected_close_date", "contact_id"] as const;
export type StageRequiredField = (typeof STAGE_REQUIRED_FIELDS)[number];

export const STAGE_REQUIRED_LABELS: Record<StageRequiredField, string> = {
  amount: "סכום",
  expected_close_date: "תאריך סגירה צפוי",
  contact_id: "איש קשר",
};

/** The deal's columns behind each field. */
const COLUMN: Record<StageRequiredField, "amount_agorot" | "expected_close_date" | "contact_id"> = {
  amount: "amount_agorot",
  expected_close_date: "expected_close_date",
  contact_id: "contact_id",
};

export const BUILTIN_PREFIX = "builtin:";

export function isStageRequiredField(value: unknown): value is StageRequiredField {
  return typeof value === "string" && (STAGE_REQUIRED_FIELDS as readonly string[]).includes(value);
}

/** The stored list as known keys, in the list's order, each once. */
export function stageRequiredFields(stored: unknown): StageRequiredField[] {
  const values = Array.isArray(stored) ? stored : [];
  return STAGE_REQUIRED_FIELDS.filter((field) => values.includes(field));
}

/** The deal row's value of a field is empty (amount 0 counts as a value). */
export function stageFieldMissing(field: StageRequiredField, deal: Record<string, unknown>): boolean {
  const value = deal[COLUMN[field]];
  return value === null || value === undefined || value === "";
}

/**
 * The field as the move asks for it: a definition the custom-field inputs know how to show and parse
 * (amount: shekels into agorot; date; contact: a choice from the business's contacts).
 */
export function stageRequiredDefinition(field: StageRequiredField, contacts: Array<{ id: string; name: string }> = []): FieldDefinition {
  const base = { id: `${BUILTIN_PREFIX}${field}`, key: `${BUILTIN_PREFIX}${field}`, label: STAGE_REQUIRED_LABELS[field], options: [], isRequired: true, isActive: true, helpText: null };
  if (field === "amount") return { ...base, type: "currency" };
  if (field === "expected_close_date") return { ...base, type: "date" };
  return { ...base, type: "user", choices: contacts.map((contact) => ({ value: contact.id, label: contact.name })) };
}

/** Whether a field asked by a move is one of these built-in fields. */
export function isBuiltinKey(key: string): boolean {
  return key.startsWith(BUILTIN_PREFIX) && isStageRequiredField(key.slice(BUILTIN_PREFIX.length));
}

/**
 * The values a move collected, split: the built-in fields as the deal's columns, the rest as the custom fields'
 * patch ({"$merge": …} is added by the caller). Either is undefined when empty.
 */
export function splitMovePatch(patch: Record<string, Json> | undefined): { columns: Record<string, Json> | undefined; custom: Record<string, Json> | undefined } {
  if (!patch) return { columns: undefined, custom: undefined };
  const columns: Record<string, Json> = {};
  const custom: Record<string, Json> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (isBuiltinKey(key)) columns[COLUMN[key.slice(BUILTIN_PREFIX.length) as StageRequiredField]] = value;
    else custom[key] = value;
  }
  return { columns: Object.keys(columns).length ? columns : undefined, custom: Object.keys(custom).length ? custom : undefined };
}
