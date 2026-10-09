import "server-only";

import { fail, FORM_INVALID, formValues } from "@/lib/action-result";
import type { Json } from "@/lib/database.types";

import { listFieldDefinitions } from "./queries";
import { inputName, type FieldObject } from "./types";
import { parseCustomFields } from "./values";

/**
 * Custom fields of a submitted form, ready to store. A new record gets the
 * filled-in fields. An existing record gets {"$merge": ...}: the database
 * merges the form's fields into the row as it is now (FXD-04, migration 0042),
 * so fields the form does not show keep their values and two editors do not
 * overwrite each other. Returns a failure result when a field is invalid.
 */
export async function customFieldsFromForm(
  orgId: string,
  objectType: FieldObject,
  formData: FormData,
  recordId?: string,
): Promise<{ ok: true; customFields: Json | undefined } | ReturnType<typeof fail>> {
  const definitions = await listFieldDefinitions(orgId, objectType);
  if (definitions.length === 0) {
    return { ok: true, customFields: undefined };
  }
  const { values, errors } = parseCustomFields(definitions, formData);
  if (Object.keys(errors).length > 0) {
    const typed = formValues(formData);
    // a multiple choice sends one input per pick; keep them all for the form shown again
    for (const field of definitions) {
      if (field.type === "multi_select") typed[inputName(field.key)] = formData.getAll(inputName(field.key)).filter((v) => typeof v === "string").join("\n");
    }
    return fail(FORM_INVALID, { fieldErrors: errors, values: typed });
  }

  if (recordId) {
    // a null clears that field
    return { ok: true, customFields: { $merge: values as Record<string, Json> } };
  }
  const merged: Record<string, Json> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value !== undefined) {
      merged[key] = value;
    }
  }
  return { ok: true, customFields: merged };
}

/** Spread into an insert or update: sets custom_fields only when the form had custom fields. */
export function customFieldsPatch(customFields: Json | undefined): { custom_fields?: Json } {
  return customFields === undefined ? {} : { custom_fields: customFields };
}
