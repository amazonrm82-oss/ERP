import type { Json } from "@/lib/database.types";

// Objects that carry custom fields (field_definitions.object_type).
export const FIELD_OBJECTS = ["lead", "contact", "company", "deal"] as const;
export type FieldObject = (typeof FIELD_OBJECTS)[number];

export const FIELD_OBJECT_LABELS: Record<FieldObject, string> = {
  lead: "לידים",
  contact: "אנשי קשר",
  company: "חברות",
  deal: "עסקאות",
};

// The field types the screens support so far (the database accepts more).
export const FIELD_TYPES = ["text", "long_text", "number", "select", "checkbox", "date", "phone", "email", "url"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "טקסט קצר",
  long_text: "טקסט ארוך",
  number: "מספר",
  select: "בחירה מרשימה",
  checkbox: "כן / לא",
  date: "תאריך",
  phone: "טלפון",
  email: "אימייל",
  url: "קישור",
};

export type FieldDefinition = {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  // select: the choices, in order
  options: string[];
  isRequired: boolean;
  isActive: boolean;
  helpText: string | null;
};

export function isFieldType(value: string): value is FieldType {
  return (FIELD_TYPES as readonly string[]).includes(value);
}

/** Form input name of a custom field. */
export function inputName(key: string): string {
  return `cf_${key}`;
}

export type CustomValues = Record<string, Json | undefined>;

export function asCustomValues(value: Json): CustomValues {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
