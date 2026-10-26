import { CHANNEL_OPTIONS, isContactChannel, isContactLocale, LOCALE_OPTIONS } from "@/features/contacts/preferences";
import { inputName, type FieldDefinition } from "@/features/custom-fields/types";
import { displayCustomFields, durationInput, parseCustomFields } from "@/features/custom-fields/values";
import { isCalendarDate } from "@/lib/calendar-date";
import type { Json } from "@/lib/database.types";
import { formatDate, zoneDate, zoneTime } from "@/lib/format";

import { BUILTIN_SET_FIELDS, TASK_TYPES, type Entity } from "./definitions";

// AUT-01: the "set_field" step. The builder keeps the value as typed (a string; a multiple choice one per line,
// a checkbox "true" or empty); the stored rule keeps the field's own JSON value, read by the same rules a record
// form uses (parseCustomFields), so the engine's check (app.custom_value_ok) agrees with it. Empty = clear.

export const CUSTOM_PREFIX = "cf:";

export type SetFieldLookups = {
  sources: Array<{ id: string; name: string }>;
  fields: Partial<Record<Entity, FieldDefinition[]>>;
};

export type SetFieldChoice = { key: string; label: string; definition?: FieldDefinition };

/** The fields a step may set on a record type: the built-in ones, then the active custom fields in their order. */
export function setFieldChoices(entity: Entity, lookups: Pick<SetFieldLookups, "fields">): SetFieldChoice[] {
  const builtins = BUILTIN_SET_FIELDS.filter((field) => field.entities.includes(entity)).map((field) => ({ key: field.key, label: field.label }));
  // FLD-06 part B: an automation never sets a record link or a file (the database refuses it in a run)
  const custom = (lookups.fields[entity] ?? [])
    .filter((definition) => automationSettable(definition))
    .map((definition) => ({ key: `${CUSTOM_PREFIX}${definition.key}`, label: definition.label, definition }));
  return [...builtins, ...custom];
}

/** FLD-06 part B: whether a step may set this custom field (a record link and a file are a person's choice). */
export function automationSettable(definition: Pick<FieldDefinition, "type">): boolean {
  return definition.type !== "record_link" && definition.type !== "file";
}

/** The custom field a "cf:<key>" names, among the active ones of the record type. */
export function customDefinition(entity: Entity, field: string, lookups: Pick<SetFieldLookups, "fields">): FieldDefinition | undefined {
  if (!field.startsWith(CUSTOM_PREFIX)) return undefined;
  const key = field.slice(CUSTOM_PREFIX.length);
  return (lookups.fields[entity] ?? []).find((definition) => definition.key === key);
}

/**
 * AUT-01 part B (owner, 18 October 2026): a date field may take a relative date, worked out by the engine when the step
 * runs (an AUT-06 retry works it out again): {"relative": {"days": 0..365, "unit": "calendar" | "business"}}. "calendar"
 * = today in the business's zone plus N days; "business" = N working days by the business's rest days and holidays
 * (app.add_business_days; 0 = today, or the next working day). A datetime field keeps the time the step runs.
 */
export const RELATIVE_DATE_UNITS = ["calendar", "business"] as const;
export type RelativeDateUnit = (typeof RELATIVE_DATE_UNITS)[number];
export const RELATIVE_DATE_MAX_DAYS = 365;
export type RelativeDraft = { unit?: string; days?: string };

export const CHANNEL_CHOICES = CHANNEL_OPTIONS;
export const LOCALE_CHOICES = LOCALE_OPTIONS;

/** Whether the field holds a date, so it may take a relative date: the close date, or a date or datetime custom field. */
export function isDateSetField(entity: Entity, field: string, lookups: Pick<SetFieldLookups, "fields">): boolean {
  if (field === "expected_close_date") return BUILTIN_SET_FIELDS.some((b) => b.key === field && b.entities.includes(entity));
  const definition = customDefinition(entity, field, lookups);
  return definition?.type === "date" || definition?.type === "datetime";
}

function isRelativeUnit(value: unknown): value is RelativeDateUnit {
  return typeof value === "string" && (RELATIVE_DATE_UNITS as readonly string[]).includes(value);
}

/** A stored relative date, or null when the value is not one (or not a valid one). */
export function relativeOf(value: unknown): { days: number; unit: RelativeDateUnit } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const relative = (value as Record<string, unknown>).relative;
  if (!relative || typeof relative !== "object" || Array.isArray(relative)) return null;
  const { days, unit } = relative as Record<string, unknown>;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > RELATIVE_DATE_MAX_DAYS || !isRelativeUnit(unit)) return null;
  return { days, unit };
}

/** "בעוד 3 ימים", "בעוד 3 ימי עבודה", "היום", "ביום העבודה הקרוב". */
export function relativeText(relative: { days: number; unit: RelativeDateUnit }): string {
  if (relative.unit === "business") {
    if (relative.days === 0) return "ביום העבודה הקרוב";
    return relative.days === 1 ? "בעוד יום עבודה אחד" : `בעוד ${relative.days} ימי עבודה`;
  }
  if (relative.days === 0) return "היום";
  return relative.days === 1 ? "מחר" : `בעוד ${relative.days} ימים`;
}

/** The typed value -> the stored JSON value, or a Hebrew message when it does not fit the field. */
export function setFieldValue(
  entity: Entity,
  field: string,
  raw: string,
  lookups: SetFieldLookups,
  relative: RelativeDraft = {},
): { value: Json } | string {
  const text = raw.trim();
  // part B: a relative date, on a date field only
  if (relative.unit) {
    if (!isRelativeUnit(relative.unit)) return "יש לבחור איך לחשב את התאריך.";
    if (!isDateSetField(entity, field, lookups)) return "תאריך יחסי מתאים רק לשדה תאריך.";
    const daysText = (relative.days ?? "").trim();
    const days = /^\d{1,3}$/.test(daysText) ? Number(daysText) : NaN;
    if (!Number.isInteger(days) || days > RELATIVE_DATE_MAX_DAYS) return `מספר הימים: מספר שלם מ-0 עד ${RELATIVE_DATE_MAX_DAYS}.`;
    return { value: { relative: { days, unit: relative.unit } } };
  }
  const builtin = BUILTIN_SET_FIELDS.find((b) => b.key === field);
  if (builtin) {
    if (!builtin.entities.includes(entity)) return "השדה לא מתאים לסוג הרשומה.";
    switch (builtin.key) {
      case "source_id":
        if (text === "") return { value: null };
        return lookups.sources.some((source) => source.id === text) ? { value: text } : "המקור שנבחר כבר לא קיים.";
      case "task_type":
        return TASK_TYPES.some((type) => type.value === text) ? { value: text } : "יש לבחור סוג משימה.";
      case "preferred_channel":
        if (text === "") return { value: null };
        return isContactChannel(text) ? { value: text } : "יש לבחור ערוץ מהרשימה.";
      case "preferred_locale":
        if (text === "") return { value: null };
        return isContactLocale(text) ? { value: text } : "יש לבחור שפה מהרשימה.";
      case "expected_close_date":
        if (text === "") return { value: null };
        return isCalendarDate(text) ? { value: text } : "תאריך הסגירה הצפוי לא תקין.";
    }
  }
  const definition = customDefinition(entity, field, lookups);
  if (!definition) return field.startsWith(CUSTOM_PREFIX) ? "השדה שנבחר כבר לא קיים או מוסתר." : "השדה לא מתאים לסוג הרשומה.";
  if (!automationSettable(definition)) return `${definition.label}: אוטומציה לא מעדכנת שדה מהסוג הזה.`;
  const name = inputName(definition.key);
  const form = new FormData();
  if (definition.type === "multi_select") {
    for (const part of raw.split("\n")) if (part.trim()) form.append(name, part.trim());
  } else if (definition.type === "checkbox") {
    if (text === "true") form.set(name, "on");
  } else {
    form.set(name, raw);
  }
  const { values, errors } = parseCustomFields([{ ...definition, isRequired: false, condition: null }], form);
  if (errors[name]) return `${definition.label}: ${errors[name]}`;
  return { value: values[definition.key] ?? null };
}

/** A stored value -> the text the builder shows when editing the rule. */
export function setFieldDraft(definition: FieldDefinition | undefined, value: unknown, timeZone?: string): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(String).join("\n");
  // part B: a relative date is edited through its own two inputs (setFieldRelativeDraft)
  if (typeof value === "object") return "";
  if (typeof value === "boolean") return value ? "true" : "";
  if (definition?.type === "currency" && typeof value === "number") return String(value / 100);
  if (definition?.type === "duration" && typeof value === "number") return durationInput(value);
  if (definition?.type === "datetime" && typeof value === "string") {
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? "" : `${zoneDate(at, timeZone)}T${zoneTime(at, timeZone).slice(0, 5)}`;
  }
  return String(value);
}

/** A stored relative date -> the builder's two inputs, or nothing when the value is not one. */
export function setFieldRelativeDraft(value: unknown): { relative_unit: string; relative_days: string } | null {
  const relative = relativeOf(value);
  if (relative) return { relative_unit: relative.unit, relative_days: String(relative.days) };
  // a stored shape the engine treats as invalid comes back as "calendar" with no days, to be fixed when saved again
  if (value && typeof value === "object" && !Array.isArray(value) && "relative" in value) return { relative_unit: "calendar", relative_days: "" };
  return null;
}

/** "<field>: <value>" (or "<field>: ריקון") for the rule's description. */
export function describeSetField(
  entity: Entity,
  field: string,
  value: unknown,
  lookups: SetFieldLookups,
): string {
  if (field === "source_id") {
    if (value === null || value === undefined) return "מקור: ריקון";
    return `מקור: ${lookups.sources.find((source) => source.id === value)?.name ?? "(נמחק)"}`;
  }
  if (field === "task_type") {
    return `סוג המשימה: ${TASK_TYPES.find((type) => type.value === value)?.label ?? String(value ?? "")}`;
  }
  const builtin = BUILTIN_SET_FIELDS.find((b) => b.key === field);
  if (builtin) {
    if (value === null || value === undefined) return `${builtin.label}: ריקון`;
    const relative = relativeOf(value);
    if (relative) return `${builtin.label}: ${relativeText(relative)}`;
    const options = field === "preferred_channel" ? CHANNEL_CHOICES : field === "preferred_locale" ? LOCALE_CHOICES : null;
    if (options) return `${builtin.label}: ${options.find((o) => o.value === value)?.label ?? String(value)}`;
    return `${builtin.label}: ${typeof value === "string" && isCalendarDate(value) ? formatDate(value) : String(value)}`;
  }
  const definition = customDefinition(entity, field, lookups);
  if (!definition) return "שדה שנמחק או הוסתר";
  const relative = relativeOf(value);
  if (relative) return `${definition.label}: ${relativeText(relative)}`;
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) return `${definition.label}: ריקון`;
  const [shown] = displayCustomFields([definition], { [definition.key]: value as Json });
  return `${definition.label}: ${shown.text ?? "ריקון"}`;
}
