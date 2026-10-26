import type { Json } from "@/lib/database.types";

import type { FieldDefinition, FieldType } from "./types";

// FLD-07: the settings of a custom field. The database decides
// (app.field_settings_check, migration field_settings); these mirror its rules
// so the settings form offers only what it accepts. A unit test reads the
// migration and keeps UNIQUE_TYPES equal to its list.

/** Types where one value names one record. */
export const UNIQUE_TYPES: readonly FieldType[] = ["text", "number", "email", "phone", "url", "il_id", "il_company_id"];

export function canBeUnique(type: FieldType): boolean {
  return UNIQUE_TYPES.includes(type);
}

/**
 * A "user" field has no default: the person who fills it in is not known ahead. FLD-06 part B: nor a record link or a file
 * (each names one record's own thing; the database refuses it, hint custom_field:default).
 */
export function canHaveDefault(type: FieldType): boolean {
  return type !== "user" && type !== "record_link" && type !== "file";
}

/**
 * Every type may be required. FLD-06 part B follow-up (owner, 26 October 2026): a file field too, but a file is uploaded on
 * the record's card after it is saved, so "required" is checked only when an existing record is saved from its edit card
 * (missingRequiredFiles), never on create, a board drag, a table cell or a bulk change.
 */
export function canBeRequired(type: FieldType): boolean {
  void type;
  return true;
}

/** The required file fields that hold no file on this record (FLD-06 part B follow-up; the edit card's save only). */
export function missingRequiredFiles(definitions: FieldDefinition[], stored: Record<string, Json | undefined>): FieldDefinition[] {
  return definitions.filter((field) => field.type === "file" && field.isRequired && field.isActive && isEmptyCustomValue(stored[field.key]));
}

/** Why these settings cannot be saved, or null. The value itself is checked by parseCustomFields. */
export function fieldSettingsProblem(type: FieldType, isUnique: boolean, defaultValue: Json | null | undefined): string | null {
  const hasDefault = defaultValue !== null && defaultValue !== undefined;
  if (isUnique && !canBeUnique(type)) {
    return "אפשר להגדיר כייחודי רק שדה מסוג טקסט קצר, מספר, אימייל, טלפון, קישור, תעודת זהות או ח.פ.";
  }
  if (hasDefault && isUnique) {
    return "לשדה ייחודי אין ערך ברירת מחדל, כי כל רשומה חדשה הייתה מקבלת אותו ערך.";
  }
  if (hasDefault && !canHaveDefault(type)) {
    return "לשדה מסוג משתמש אין ערך ברירת מחדל.";
  }
  return null;
}

/**
 * Empty for the read-only rule (owner, 13 October 2026): absent, null, or text that is blank after
 * trimming; 0, false and an empty list are values. Mirrors app.custom_value_empty().
 */
export function isEmptyCustomValue(value: Json | null | undefined): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

/** A read-only field the form shows but the person did not fill: an edit or a create leaves it out. */
function untouchedReadOnly(field: FieldDefinition, value: Json): boolean {
  return (
    field.isReadOnly === true &&
    (isEmptyCustomValue(value) || (field.type === "checkbox" && value !== true) || (Array.isArray(value) && value.length === 0))
  );
}

/**
 * The custom values a create form stores. Empty fields are left out; a field with a default the
 * person left empty is sent as null, so the database does not fill it in (FLD-07). An unticked
 * read-only checkbox is left out too: false is a value and would lock it at "no" for good.
 */
export function customValuesForCreate(definitions: FieldDefinition[], values: Record<string, Json | undefined>): Record<string, Json> {
  const merged: Record<string, Json> = {};
  for (const field of definitions) {
    const value = values[field.key];
    if (value === null || value === undefined || untouchedReadOnly(field, value)) continue;
    merged[field.key] = value;
  }
  for (const field of definitions) {
    if (field.defaultValue !== null && field.defaultValue !== undefined && !(field.key in merged)) merged[field.key] = null;
  }
  return merged;
}

/**
 * The patch an edit form sends ({"$merge": patch}); null clears a field. A read-only field is sent
 * only to fill it (an edit form shows a filled one as text, so an empty or unticked value means
 * "not touched"; the database refuses a change).
 */
export function customValuesForUpdate(definitions: FieldDefinition[], values: Record<string, Json | undefined>): Record<string, Json> {
  const patch: Record<string, Json> = {};
  for (const field of definitions) {
    const value = values[field.key];
    if (value === undefined || untouchedReadOnly(field, value)) continue;
    patch[field.key] = value;
  }
  return patch;
}
