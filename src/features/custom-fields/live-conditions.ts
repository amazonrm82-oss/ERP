import type { Json } from "@/lib/database.types";

import { BUILTIN_CONDITION_FIELDS, isBuiltinKey, type ConditionValues } from "./conditions";
import { inputName, type CustomValues, type FieldDefinition, type FieldObject } from "./types";

/**
 * FLD-09: the values the conditions of a form read, from the form as it is now (browser). Only
 * controlling fields matter. A controlling custom field without an input (a locked read-only one)
 * and a built-in field the form has no input for keep the record's value.
 */
export function readConditionValues(
  form: HTMLFormElement,
  definitions: FieldDefinition[],
  objectType: FieldObject | undefined,
  builtins: Record<string, string | null>,
  initial: CustomValues,
): ConditionValues {
  const data = new FormData(form);
  const has = (name: string) => form.elements.namedItem(name) !== null;
  const values: ConditionValues = { ...initial, ...builtins };
  const controllers = new Set(definitions.map((field) => field.condition?.field).filter((key): key is string => typeof key === "string"));
  for (const key of controllers) {
    if (isBuiltinKey(key)) continue;
    const field = definitions.find((item) => item.key === key);
    if (!field) continue;
    const name = inputName(key);
    if (!has(name)) continue;
    const raw = data.getAll(name).filter((value): value is string => typeof value === "string");
    values[key] = controllerValue(field, raw);
  }
  for (const builtin of objectType ? BUILTIN_CONDITION_FIELDS[objectType] : []) {
    if (!has(builtin.input)) continue;
    const raw = data.get(builtin.input);
    values[builtin.key] = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
  }
  return values;
}

function controllerValue(field: FieldDefinition, raw: string[]): Json {
  switch (field.type) {
    case "checkbox":
      return raw.some((value) => value === "on" || value === "true");
    case "multi_select":
      return raw.map((value) => value.trim()).filter(Boolean);
    case "rating": {
      const n = Number(raw[0]);
      return raw[0] && Number.isInteger(n) ? n : null;
    }
    default: {
      const text = (raw[0] ?? "").trim();
      return text === "" ? null : text;
    }
  }
}
