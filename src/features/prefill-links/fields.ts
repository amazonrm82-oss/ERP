import { FORM_EXCLUDED_TYPES } from "@/features/intake/fields";
import type { FieldDefinition, FieldType } from "@/features/custom-fields/types";

// BIZ-05: the fields a prefill form may ask. Mirrors app.prefill_builtin_keys, app.prefill_builtin_label,
// app.prefill_builtin_type and app.prefill_field_problem (migrations _prefill_forms.sql and _prefill_links.sql); a unit test
// reads the migration. NON-MEDICAL ONLY (owner, answer (271) ב): a field marked sensitive (PRK-01) is never asked.

export const PREFILL_RECORD_TYPES = ["lead", "contact"] as const;
export type PrefillRecordType = (typeof PREFILL_RECORD_TYPES)[number];

export function isPrefillRecordType(value: unknown): value is PrefillRecordType {
  return typeof value === "string" && (PREFILL_RECORD_TYPES as readonly string[]).includes(value);
}

export type PrefillBuiltIn = { key: string; label: string; type: "text" | "phone" | "email" | "date" };

export const PREFILL_BUILT_IN: Record<PrefillRecordType, readonly PrefillBuiltIn[]> = {
  lead: [
    { key: "full_name", label: "שם מלא", type: "text" },
    { key: "phone", label: "טלפון", type: "phone" },
    { key: "email", label: "אימייל", type: "email" },
    { key: "company_name", label: "שם החברה", type: "text" },
    { key: "job_title", label: "תפקיד", type: "text" },
  ],
  contact: [
    { key: "first_name", label: "שם פרטי", type: "text" },
    { key: "last_name", label: "שם משפחה", type: "text" },
    { key: "phone", label: "טלפון", type: "phone" },
    { key: "email", label: "אימייל", type: "email" },
    { key: "job_title", label: "תפקיד", type: "text" },
    { key: "address_line", label: "כתובת", type: "text" },
    { key: "city", label: "עיר", type: "text" },
    { key: "birth_date", label: "תאריך לידה", type: "date" },
  ],
};

export const PREFILL_MAX_FIELDS = 20;

export type PrefillFieldProblem = "field" | "sensitive" | null;

/** null = the key may be asked on a template of this record type (the rule of app.prefill_field_problem). */
export function prefillFieldProblem(recordType: PrefillRecordType, key: string, definitions: FieldDefinition[]): PrefillFieldProblem {
  if (PREFILL_BUILT_IN[recordType].some((field) => field.key === key)) return null;
  if (!/^cf:[a-z][a-z0-9_]{0,39}$/.test(key)) return "field";
  const definition = definitions.find((d) => d.key === key.slice(3));
  if (!definition || !definition.isActive || (FORM_EXCLUDED_TYPES as readonly FieldType[]).includes(definition.type)) return "field";
  if (definition.privacyClass === "sensitive") return "sensitive";
  return null;
}

export type PrefillChoice = { key: string; label: string };

/** The fields a person can pick for a template: the built-ins, then the record type's custom fields that may be asked. */
export function prefillChoices(recordType: PrefillRecordType, definitions: FieldDefinition[]): PrefillChoice[] {
  return [
    ...PREFILL_BUILT_IN[recordType].map((field) => ({ key: field.key, label: field.label })),
    ...definitions
      .filter((d) => prefillFieldProblem(recordType, `cf:${d.key}`, definitions) === null)
      .map((d) => ({ key: `cf:${d.key}`, label: d.label })),
  ];
}

/** A template's fields as sent by the editor: each once, at most 20, each one that may be asked; else the first problem. */
export function checkPrefillFields(recordType: PrefillRecordType, keys: string[], definitions: FieldDefinition[]): PrefillFieldProblem | "empty" | "many" {
  if (keys.length === 0) return "empty";
  if (keys.length > PREFILL_MAX_FIELDS) return "many";
  if (new Set(keys).size !== keys.length) return "field";
  for (const key of keys) {
    const problem = prefillFieldProblem(recordType, key, definitions);
    if (problem) return problem;
  }
  return null;
}
