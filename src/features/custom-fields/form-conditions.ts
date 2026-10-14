import { conditionApplies, conditionValuesFromForm, fieldState, shownMarkerName } from "./conditions";
import { isEmptyCustomValue } from "./settings";
import type { CustomValues, FieldDefinition, FieldObject } from "./types";
import { parseCustomFields } from "./values";

/** What an existing record holds that a condition may read (FLD-09). */
export type StoredForConditions = { custom: CustomValues; builtins: Record<string, string | null> };

/**
 * FLD-09: the fields as this submission must treat them. A field hidden by its condition is left
 * out (not checked, not sent: an edit keeps its stored value, a create leaves its default to the
 * database); a field whose condition makes it required becomes required. A locked read-only field
 * that holds a value is satisfied. On an edit, a conditional field whose marker input was not posted
 * (hidden in the browser) is left out too, whatever the server computes.
 */
export function effectiveDefinitions(
  objectType: FieldObject,
  definitions: FieldDefinition[],
  formData: FormData,
  stored: StoredForConditions | null,
  editing: boolean,
  written: readonly string[] = [],
): FieldDefinition[] {
  const loose = definitions.map((field) => ({ ...field, isRequired: false }));
  const { values } = parseCustomFields(loose, formData);
  // a locked read-only value is not in the form: the record's value counts
  const parsed: CustomValues = {};
  for (const field of definitions) {
    const locked = editing && field.isReadOnly && !isEmptyCustomValue(stored?.custom[field.key] ?? null);
    if (!locked) parsed[field.key] = values[field.key];
  }
  const conditionValues = conditionValuesFromForm(objectType, formData, parsed, stored ?? {}, written);
  const result: FieldDefinition[] = [];
  for (const field of definitions) {
    const state = fieldState(field, definitions, conditionValues, objectType);
    if (!state.visible) continue;
    const conditional = field.condition ? conditionApplies(field.condition, definitions, objectType) : false;
    if (editing && conditional && !formData.has(shownMarkerName(field.key))) continue;
    const locked = editing && field.isReadOnly && !isEmptyCustomValue(stored?.custom[field.key] ?? null);
    result.push({ ...field, isRequired: state.required && !locked });
  }
  return result;
}
