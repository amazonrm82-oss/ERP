import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { fail, FORM_INVALID, formValues } from "@/lib/action-result";
import type { Database, Json } from "@/lib/database.types";

import { listFieldDefinitions } from "./queries";
import { asCustomValues, type CustomValues, type FieldObject } from "./types";
import { parseCustomFields } from "./values";

const TABLE = { lead: "leads", contact: "contacts", company: "companies", deal: "deals" } as const;

/**
 * Custom fields of a submitted form, ready to store: the active fields from the
 * form merged over what the record already holds (so values of inactive or
 * unsupported fields are kept). Returns a failure result when a field is invalid.
 */
export async function customFieldsFromForm(
  supabase: SupabaseClient<Database>,
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
    return fail(FORM_INVALID, { fieldErrors: errors, values: formValues(formData) });
  }

  let current: CustomValues = {};
  if (recordId) {
    const { data } = await supabase
      .from(TABLE[objectType] as "leads")
      .select("custom_fields")
      .eq("organization_id", orgId)
      .eq("id", recordId)
      .maybeSingle();
    current = asCustomValues((data?.custom_fields as Json | undefined) ?? {});
  }
  const merged: Record<string, Json> = {};
  for (const [key, value] of Object.entries({ ...current, ...values })) {
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
