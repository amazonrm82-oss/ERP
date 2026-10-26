import type { Json } from "@/lib/database.types";
import { RECORD_TYPES } from "@/lib/record-types";

import type { FieldCondition } from "./conditions";

// Objects that carry custom fields (field_definitions.object_type).
export const FIELD_OBJECTS = ["lead", "contact", "company", "deal"] as const;
export type FieldObject = (typeof FIELD_OBJECTS)[number];

export const FIELD_OBJECT_LABELS: Record<FieldObject, string> = {
  lead: RECORD_TYPES.lead.plural,
  contact: RECORD_TYPES.contact.plural,
  company: RECORD_TYPES.company.plural,
  deal: RECORD_TYPES.deal.plural,
};

// Every field type the database accepts (FLD-01 added eight to the screens; FLD-06 part A added rich_text,
// duration and status; part B address, record_link and file). A new type also needs its decision in every place listed
// in type-decisions.ts.
export const FIELD_TYPES = [
  "text", "long_text", "number", "currency", "percent", "rating", "select", "multi_select", "checkbox",
  "date", "datetime", "phone", "email", "url", "il_id", "il_company_id", "user",
  "rich_text", "duration", "status",
  "address", "record_link", "file",
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
  rich_text: "טקסט מעוצב",
  duration: "משך זמן",
  status: "סטטוס צבעוני",
  address: "כתובת",
  record_link: "קישור לרשומה",
  file: "קובץ",
};

// FLD-06 part B: what a record_link field may point at (field_definitions.link_target, constraint
// field_definitions_link_target_check)
export const LINK_TARGETS = FIELD_OBJECTS;
export type LinkTarget = FieldObject;
export function isLinkTarget(value: unknown): value is LinkTarget {
  return typeof value === "string" && (LINK_TARGETS as readonly string[]).includes(value);
}

/** FLD-06 part B: how a record link or a file value is shown, read for the page with the viewer's session. */
export type FieldRef = { label: string; href: string | null };

// types whose choices are typed in the field settings
export const TYPES_WITH_OPTIONS: readonly FieldType[] = ["select", "multi_select", "status"];

export type FieldDefinition = {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  // select, multi_select and status: the choices, in order
  options: string[];
  // FLD-06 status: each option's palette key (status-colors.ts); a missing one shows neutral
  optionColors?: Record<string, string>;
  // user: the business's members, filled in when the definitions are read
  choices?: Array<{ value: string; label: string }>;
  // FLD-06 part B: a record_link field's target type
  linkTarget?: LinkTarget | null;
  // FLD-06 part B: the record links' and files' names for this page, by id (filled by withFieldRefs); an id that is
  // missing here is shown neutrally ("רשומה" / "קובץ"), never by its id
  refs?: Record<string, FieldRef>;
  // FLD-06 part B: the business, for the record link picker and the file field's upload
  orgId?: string;
  // DEAL-05's built-in contact: asked with the contact search picker of this business instead of a list of choices
  contactPicker?: { orgId: string };
  isRequired: boolean;
  isActive: boolean;
  helpText: string | null;
  // FLD-07 settings (src/features/custom-fields/settings.ts); absent = off / none
  isUnique?: boolean;
  isReadOnly?: boolean;
  defaultValue?: Json | null;
  // FLD-09 (src/features/custom-fields/conditions.ts); absent = none
  condition?: FieldCondition | null;
  // FLD-09 part B: set by the database when a deleted pipeline left the field with no condition; cleared when
  // the field is saved again (settings list only)
  conditionRemovedAt?: string | null;
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

/** FLD-06 part B: a list sorts by a custom field's stored value; a record link or a file holds an id, so it does not sort. */
export function sortableField(field: Pick<FieldDefinition, "type">): boolean {
  return field.type !== "record_link" && field.type !== "file";
}
