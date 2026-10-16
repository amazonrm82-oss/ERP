import { inputName, type FieldDefinition } from "@/features/custom-fields/types";
import { displayCustomFields, durationInput, parseCustomFields } from "@/features/custom-fields/values";
import type { Json } from "@/lib/database.types";
import { zoneDate, zoneTime } from "@/lib/format";

import { BUILTIN_SET_FIELDS, TASK_TYPES, type Entity } from "./definitions";

// AUT-01: the "set_field" step. The builder keeps the value as typed (a string; a multiple choice one per line,
// a checkbox "true" or empty); the stored rule keeps the field's own JSON value, read by the same rules a record
// form uses (parseCustomFields), so the engine's check (app.custom_value_ok) agrees with it. Empty = clear.

export const CUSTOM_PREFIX = "cf:";

export type SetFieldLookups = {
  sources: Array<{ id: string; name: string }>;
  fields: Partial<Record<Entity, FieldDefinition[]>>;
};

export type SetFieldChoice = { key: string; label: string; definition?: FieldDefinition };

/** The fields a step may set on a record type: the built-in ones, then the active custom fields in their order. */
export function setFieldChoices(entity: Entity, lookups: Pick<SetFieldLookups, "fields">): SetFieldChoice[] {
  const builtins = BUILTIN_SET_FIELDS.filter((field) => field.entities.includes(entity)).map((field) => ({ key: field.key, label: field.label }));
  const custom = (lookups.fields[entity] ?? []).map((definition) => ({ key: `${CUSTOM_PREFIX}${definition.key}`, label: definition.label, definition }));
  return [...builtins, ...custom];
}

/** The custom field a "cf:<key>" names, among the active ones of the record type. */
export function customDefinition(entity: Entity, field: string, lookups: Pick<SetFieldLookups, "fields">): FieldDefinition | undefined {
  if (!field.startsWith(CUSTOM_PREFIX)) return undefined;
  const key = field.slice(CUSTOM_PREFIX.length);
  return (lookups.fields[entity] ?? []).find((definition) => definition.key === key);
}

/** The typed value -> the stored JSON value, or a Hebrew message when it does not fit the field. */
export function setFieldValue(entity: Entity, field: string, raw: string, lookups: SetFieldLookups): { value: Json } | string {
  const text = raw.trim();
  if (field === "source_id" || field === "task_type") {
    if (!BUILTIN_SET_FIELDS.some((builtin) => builtin.key === field && builtin.entities.includes(entity))) return "השדה לא מתאים לסוג הרשומה.";
    if (field === "source_id") {
      if (text === "") return { value: null };
      return lookups.sources.some((source) => source.id === text) ? { value: text } : "המקור שנבחר כבר לא קיים.";
    }
    return TASK_TYPES.some((type) => type.value === text) ? { value: text } : "יש לבחור סוג משימה.";
  }
  const definition = customDefinition(entity, field, lookups);
  if (!definition) return field.startsWith(CUSTOM_PREFIX) ? "השדה שנבחר כבר לא קיים או מוסתר." : "השדה לא מתאים לסוג הרשומה.";
  const name = inputName(definition.key);
  const form = new FormData();
  if (definition.type === "multi_select") {
    for (const part of raw.split("\n")) if (part.trim()) form.append(name, part.trim());
  } else if (definition.type === "checkbox") {
    if (text === "true") form.set(name, "on");
  } else {
    form.set(name, raw);
  }
  const { values, errors } = parseCustomFields([{ ...definition, isRequired: false, condition: null }], form);
  if (errors[name]) return `${definition.label}: ${errors[name]}`;
  return { value: values[definition.key] ?? null };
}

/** A stored value -> the text the builder shows when editing the rule. */
export function setFieldDraft(definition: FieldDefinition | undefined, value: unknown, timeZone?: string): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(String).join("\n");
  if (typeof value === "boolean") return value ? "true" : "";
  if (definition?.type === "currency" && typeof value === "number") return String(value / 100);
  if (definition?.type === "duration" && typeof value === "number") return durationInput(value);
  if (definition?.type === "datetime" && typeof value === "string") {
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? "" : `${zoneDate(at, timeZone)}T${zoneTime(at, timeZone).slice(0, 5)}`;
  }
  return String(value);
}

/** "<field>: <value>" (or "<field>: ריקון") for the rule's description. */
export function describeSetField(
  entity: Entity,
  field: string,
  value: unknown,
  lookups: SetFieldLookups,
): string {
  if (field === "source_id") {
    if (value === null || value === undefined) return "מקור: ריקון";
    return `מקור: ${lookups.sources.find((source) => source.id === value)?.name ?? "(נמחק)"}`;
  }
  if (field === "task_type") {
    return `סוג המשימה: ${TASK_TYPES.find((type) => type.value === value)?.label ?? String(value ?? "")}`;
  }
  const definition = customDefinition(entity, field, lookups);
  if (!definition) return "שדה שנמחק או הוסתר";
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) return `${definition.label}: ריקון`;
  const [shown] = displayCustomFields([definition], { [definition.key]: value as Json });
  return `${definition.label}: ${shown.text ?? "ריקון"}`;
}
