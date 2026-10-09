import type { Json } from "@/lib/database.types";
import { RECORD_TYPES } from "@/lib/record-types";

// Objects that carry custom fields (field_definitions.object_type).
export const FIELD_OBJECTS = ["lead", "contact", "company", "deal"] as const;
export type FieldObject = (typeof FIELD_OBJECTS)[number];

export const FIELD_OBJECT_LABELS: Record<FieldObject, string> = {
  lead: RECORD_TYPES.lead.plural,
  contact: RECORD_TYPES.contact.plural,
  company: RECORD_TYPES.company.plural,
  deal: RECORD_TYPES.deal.plural,
};

// Every field type the database accepts (FLD-01 added the last eight to the screens).
export const FIELD_TYPES = [
  "text", "long_text", "number", "currency", "percent", "rating", "select", "multi_select", "checkbox",
  "date", "datetime", "phone", "email", "url", "il_id", "il_company_id", "user",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "טקסט קצר",
  long_text: "טקסט ארוך",
  number: "מספר",
  currency: "סכום בשקלים",
  percent: "אחוז",
  rating: "דירוג (1 עד 5)",
  select: "בחירה מרשימה",
  multi_select: "בחירה מרובה מרשימה",
  checkbox: "כן / לא",
  date: "תאריך",
  datetime: "תאריך ושעה",
  phone: "טלפון",
  email: "אימייל",
  url: "קישור",
  il_id: "תעודת זהות",
  il_company_id: "ח.פ. / מספר עוסק",
  user: "משתמש בעסק",
};

// types whose choices are typed in the field settings
export const TYPES_WITH_OPTIONS: readonly FieldType[] = ["select", "multi_select"];

export type FieldDefinition = {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  // select and multi_select: the choices, in order
  options: string[];
  // user: the business's members, filled in when the definitions are read
  choices?: Array<{ value: string; label: string }>;
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
