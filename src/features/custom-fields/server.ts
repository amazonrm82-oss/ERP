import "server-only";

import { fail, FORM_INVALID, formValues } from "@/lib/action-result";
import type { Json } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";

import { BUILTIN_CONDITION_FIELDS, hasConditions, missingFieldsMessage } from "./conditions";
import { effectiveDefinitions, type StoredForConditions } from "./form-conditions";
import { listFieldDefinitions } from "./queries";
import { asCustomValues, inputName, type FieldObject } from "./types";
import { customValuesForCreate, customValuesForUpdate, missingRequiredFiles } from "./settings";
import { parseCustomFields } from "./values";

/**
 * FLD-09: what an existing record holds that a condition may read and the form may not send (a
 * built-in field the edit form has no input for, a locked read-only value). Read with the user's
 * session; null when the record cannot be read (the update then finds nothing either).
 */
async function storedForConditions(orgId: string, objectType: FieldObject, recordId: string): Promise<StoredForConditions | null> {
  const supabase = await createClient();
  const columns = BUILTIN_CONDITION_FIELDS[objectType].map((field) => field.input);
  const select = ["custom_fields", ...columns].join(", ");
  const table = objectType === "lead" ? "leads" : objectType === "contact" ? "contacts" : objectType === "company" ? "companies" : "deals";
  const { data, error } = await supabase.from(table).select(select).eq("organization_id", orgId).eq("id", recordId).maybeSingle();
  if (error || !data) return null;
  const row = data as unknown as Record<string, Json>;
  const builtins: Record<string, string | null> = {};
  for (const field of BUILTIN_CONDITION_FIELDS[objectType]) {
    const value = row[field.input];
    builtins[field.key] = typeof value === "string" ? value : null;
  }
  return { custom: asCustomValues(row.custom_fields ?? null), builtins };
}

/** The record's stored custom values, for the required file check (null when it cannot be read: the update finds nothing). */
async function storedFileValues(orgId: string, objectType: FieldObject, recordId: string): Promise<Record<string, Json | undefined> | null> {
  const supabase = await createClient();
  const table = objectType === "lead" ? "leads" : objectType === "contact" ? "contacts" : objectType === "company" ? "companies" : "deals";
  const { data, error } = await supabase.from(table).select("custom_fields").eq("organization_id", orgId).eq("id", recordId).maybeSingle();
  if (error || !data) return null;
  return asCustomValues((data as { custom_fields: Json | null }).custom_fields ?? null);
}

/**
 * Custom fields of a submitted form, ready to store. A new record gets the
 * filled-in fields. An existing record gets {"$merge": ...}: the database
 * merges the form's fields into the row as it is now (FXD-04, migration 0042),
 * so fields the form does not show keep their values and two editors do not
 * overwrite each other. Returns a failure result when a field is invalid.
 * A read-only field (FLD-07) is sent only when it is being filled (customValuesFor*).
 * Conditions (FLD-09) decide which fields count and which are required (effectiveDefinitions).
 */
export async function customFieldsFromForm(
  orgId: string,
  objectType: FieldObject,
  formData: FormData,
  recordId?: string,
  // FLD-09: the built-in fields ("builtin:status") this action writes from the form; a condition reads
  // only those from the form, the others from the record
  builtinsWritten: readonly string[] = [],
): Promise<{ ok: true; customFields: Json | undefined } | ReturnType<typeof fail>> {
  const allDefinitions = await listFieldDefinitions(orgId, objectType);
  if (allDefinitions.length === 0) {
    return { ok: true, customFields: undefined };
  }
  const definitions = hasConditions(allDefinitions, objectType)
    ? effectiveDefinitions(objectType, allDefinitions, formData, recordId ? await storedForConditions(orgId, objectType, recordId) : null, recordId !== undefined, builtinsWritten)
    : allDefinitions;
  const { values, errors } = parseCustomFields(definitions, formData);
  // FLD-06 part B follow-up (owner, 26 October 2026): a required file field is checked only when an existing record is saved
  // from its edit card (a new record gets its file after it is saved); the file itself is uploaded on its own
  let missingFiles: string[] = [];
  if (recordId && definitions.some((field) => field.type === "file" && field.isRequired)) {
    const stored = await storedFileValues(orgId, objectType, recordId);
    if (stored) {
      const missing = missingRequiredFiles(definitions, stored);
      for (const field of missing) errors[inputName(field.key)] = "יש לצרף קובץ.";
      missingFiles = missing.map((field) => field.label);
    }
  }
  if (Object.keys(errors).length > 0) {
    const typed = formValues(formData);
    // a multiple choice sends one input per pick; keep them all for the form shown again
    for (const field of definitions) {
      if (field.type === "multi_select") typed[inputName(field.key)] = formData.getAll(inputName(field.key)).filter((v) => typeof v === "string").join("\n");
    }
    const message = missingFiles.length > 0 && missingFiles.length === Object.keys(errors).length ? missingFieldsMessage(missingFiles.map((label) => ({ label }))) : FORM_INVALID;
    return fail(message, { fieldErrors: errors, values: typed });
  }

  if (recordId) {
    return { ok: true, customFields: { $merge: customValuesForUpdate(definitions, values) } };
  }
  return { ok: true, customFields: customValuesForCreate(definitions, values) };
}

/** Spread into an insert or update: sets custom_fields only when the form had custom fields. */
export function customFieldsPatch(customFields: Json | undefined): { custom_fields?: Json } {
  return customFields === undefined ? {} : { custom_fields: customFields };
}
