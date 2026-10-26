import type { Json } from "@/lib/database.types";
import type { FieldDefinition, FieldType } from "@/features/custom-fields/types";

// The lead fields a public form can ask for, in a sensible default order.
export const INTAKE_FIELDS = ["full_name", "phone", "email", "company_name", "message"] as const;
export type IntakeField = (typeof INTAKE_FIELDS)[number];

export const INTAKE_FIELD_LABELS: Record<IntakeField, string> = {
  full_name: "שם מלא",
  phone: "טלפון",
  email: "אימייל",
  company_name: "חברה",
  message: "הודעה",
};

// CAP-01: a custom field of leads sits on a form as "cf:<key>".
export const CUSTOM_PREFIX = "cf:";
// limits, the same as app.form_fields_ok() (migration 0054)
export const MAX_FORM_FIELDS = 40;
export const MAX_HELP_LENGTH = 300;
export const MAX_SHOW_VALUE_LENGTH = 200;
// picking a team member is not something a visitor does. FLD-06 part A: rich text (a visitor's text is shown
// as plain text, REC-04), duration and status stay off public forms for now (a follow-up decides). FLD-06 part B: an
// address is a plain line a visitor types (on forms); a record link names a record of the business and a file needs the
// record first, so neither is a visitor's.
export const FORM_EXCLUDED_TYPES: readonly FieldType[] = ["user", "rich_text", "duration", "status", "record_link", "file"];

/** Shown only when an earlier field has a value (any value when `value` is null, else that choice). */
export type ShowIf = { field: string; value: string | null };

/** One field of a form, as stored in forms.fields. */
export type FormFieldConfig = { key: string; required: boolean; help?: string | null; showIf?: ShowIf | null };

export function isIntakeField(value: unknown): value is IntakeField {
  return typeof value === "string" && (INTAKE_FIELDS as readonly string[]).includes(value);
}

const CUSTOM_KEY = /^cf:[a-z][a-z0-9_]{0,39}$/;

export function isCustomFormKey(value: unknown): value is string {
  return typeof value === "string" && CUSTOM_KEY.test(value);
}

export function isFormFieldKey(value: unknown): value is string {
  return isIntakeField(value) || isCustomFormKey(value);
}

/** "cf:budget" -> "budget". */
export function customKeyOf(formKey: string): string {
  return formKey.slice(CUSTOM_PREFIX.length);
}

/** The name of a field's input on the hosted form (custom fields: cf_<key>, as on the record forms). */
export function formInputName(formKey: string): string {
  return isCustomFormKey(formKey) ? `cf_${customKeyOf(formKey)}` : formKey;
}

function isObject(value: unknown): value is Record<string, Json | undefined> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** forms.fields (jsonb) -> known fields in their stored order. Conditions on a later or unknown field are dropped. */
export function parseFieldsConfig(value: Json): FormFieldConfig[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const fields: FormFieldConfig[] = [];
  for (const item of value) {
    if (!isObject(item) || !isFormFieldKey(item.key) || seen.has(item.key)) {
      continue;
    }
    const help = typeof item.help === "string" && item.help.trim() !== "" ? item.help.trim() : null;
    let showIf: ShowIf | null = null;
    const cond = item.show_if;
    if (isObject(cond) && typeof cond.field === "string" && seen.has(cond.field)) {
      showIf = { field: cond.field, value: typeof cond.value === "string" && cond.value !== "" ? cond.value : null };
    }
    seen.add(item.key);
    fields.push({ key: item.key, required: item.required === true, help, showIf });
  }
  return fields;
}

/** The stored shape (forms.fields) of a list of fields. */
export function storedFields(fields: FormFieldConfig[]): Json {
  return fields.map((field) => ({
    key: field.key,
    required: field.required,
    ...(field.help ? { help: field.help } : {}),
    ...(field.showIf ? { show_if: { field: field.showIf.field, value: field.showIf.value } } : {}),
  }));
}

// Names of the anti-spam inputs on the hosted form.
export const HONEYPOT_FIELD = "website_url";
export const STARTED_AT_FIELD = "_started";

/** A field the form builder can place: built-in, or a custom field of leads. */
export type FormFieldOption = { key: string; label: string; type: FieldType | null; options: string[]; isActive: boolean };

/** Every field the builder offers, built-in first; "user" fields are left out. */
export function formFieldOptions(definitions: FieldDefinition[]): FormFieldOption[] {
  return [
    ...INTAKE_FIELDS.map((key) => ({ key, label: INTAKE_FIELD_LABELS[key], type: null, options: [], isActive: true })),
    ...definitions
      .filter((definition) => !FORM_EXCLUDED_TYPES.includes(definition.type))
      .map((definition) => ({
        key: `${CUSTOM_PREFIX}${definition.key}`,
        label: definition.label,
        type: definition.type,
        options: definition.options,
        isActive: definition.isActive,
      })),
  ];
}
