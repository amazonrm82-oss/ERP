import type { Json } from "@/lib/database.types";

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

export type FormFieldConfig = { key: IntakeField; required: boolean };

export function isIntakeField(value: unknown): value is IntakeField {
  return typeof value === "string" && (INTAKE_FIELDS as readonly string[]).includes(value);
}

/** forms.fields (jsonb) -> known fields in their stored order. */
export function parseFieldsConfig(value: Json): FormFieldConfig[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const fields: FormFieldConfig[] = [];
  for (const item of value) {
    if (item && typeof item === "object" && !Array.isArray(item) && isIntakeField(item.key) && !seen.has(item.key)) {
      seen.add(item.key);
      fields.push({ key: item.key, required: item.required === true });
    }
  }
  return fields;
}

// Names of the anti-spam inputs on the hosted form.
export const HONEYPOT_FIELD = "website_url";
export const STARTED_AT_FIELD = "_started";
