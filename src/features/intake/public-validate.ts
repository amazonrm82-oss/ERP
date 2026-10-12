import { parseCustomFields } from "@/features/custom-fields/values";
import type { FieldDefinition, FieldType } from "@/features/custom-fields/types";
import type { Json } from "@/lib/database.types";

import {
  customKeyOf,
  formInputName,
  INTAKE_FIELD_LABELS,
  INTAKE_FIELDS,
  isCustomFormKey,
  isIntakeField,
  type FormFieldConfig,
  type IntakeField,
} from "./fields";

// The same rules intake_submit() applies (migrations 0007, 0054), checked in
// the browser first so each wrong field gets its own message (FXA-02), and
// again on the server before the database. Conditions and "has a value"
// mirror app.intake_condition_met() / app.intake_has_value(); keep in step.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What the hosted form knows of a custom field. */
export type PublicCustom = { type: FieldType; label: string; options: string[] };

/** A field as the hosted form shows it: built-in, or custom with its definition. */
export type PublicField = FormFieldConfig & { label?: string; custom?: PublicCustom | null };

/** What was typed, by input name (a multiple choice sends a list). */
export type RawValues = Record<string, string | string[] | undefined>;

export type CheckedSubmission = {
  // by input name
  errors: Record<string, string>;
  // the five lead fields; one on the form but hidden is null
  builtins: Record<IntakeField, string | null>;
  // custom key -> typed value, for shown fields with a value
  custom: Record<string, Json>;
  // form keys of the fields shown
  visible: Set<string>;
};

/** Not null, not blank, not false, not an empty list. */
export function hasValue(value: Json | undefined): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** show_if is met by this value. */
export function conditionMet(value: Json | undefined, expected: string | null): boolean {
  if (!hasValue(value)) return false;
  if (expected === null) return true;
  if (typeof value === "string") return value === expected;
  if (Array.isArray(value)) return value.includes(expected);
  return false;
}

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function definitionOf(field: PublicField): FieldDefinition | null {
  if (!isCustomFormKey(field.key) || !field.custom) return null;
  // "required" is decided below, after the conditions
  return {
    id: field.key,
    key: customKeyOf(field.key),
    label: field.custom.label,
    type: field.custom.type,
    options: field.custom.options,
    isRequired: false,
    isActive: true,
    helpText: null,
  };
}

function requiredMessage(field: PublicField): string {
  if (isIntakeField(field.key)) return `יש למלא ${INTAKE_FIELD_LABELS[field.key]}.`;
  if (field.custom?.type === "checkbox") return "יש לסמן את השדה.";
  if (field.custom?.type === "multi_select") return "יש לבחור לפחות ערך אחד.";
  return "יש למלא את השדה.";
}

/** Which fields are shown, their typed values, and a message per wrong field. */
export function checkSubmission(fields: PublicField[], values: RawValues): CheckedSubmission {
  const definitions = fields.map(definitionOf).filter((d): d is FieldDefinition => d !== null);
  const form = new FormData();
  for (const definition of definitions) {
    const name = formInputName(`cf:${definition.key}`);
    const raw = values[name];
    for (const item of Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]) form.append(name, item);
  }
  const parsed = parseCustomFields(definitions, form);

  // a lead field that is not on the form passes as sent (an HTML form on another site may add it)
  const onForm = new Set(fields.map((field) => field.key));
  const builtins = Object.fromEntries(
    INTAKE_FIELDS.map((key) => [key, onForm.has(key) ? null : first(values[key]).trim() || null]),
  ) as Record<IntakeField, string | null>;
  const typed: Record<string, Json> = {};
  const custom: Record<string, Json> = {};
  const errors: Record<string, string> = {};
  const visible = new Set<string>();

  for (const field of fields) {
    if (visible.has(field.key)) continue;
    let value: Json | undefined;
    if (isIntakeField(field.key)) {
      value = first(values[field.key]).trim() || null;
    } else if (definitionOf(field)) {
      value = parsed.values[customKeyOf(field.key)];
    } else {
      continue; // a custom field that is no longer on the form
    }
    const cond = field.showIf;
    if (cond && !(visible.has(cond.field) && conditionMet(typed[cond.field], cond.value))) {
      continue;
    }
    visible.add(field.key);
    const name = formInputName(field.key);
    if (isIntakeField(field.key)) {
      builtins[field.key] = (value as string | null) ?? null;
    } else if (parsed.errors[name]) {
      errors[name] = parsed.errors[name];
      continue;
    } else if (hasValue(value)) {
      custom[customKeyOf(field.key)] = value as Json;
    }
    if (hasValue(value)) typed[field.key] = value as Json;
    if (field.required && !hasValue(value)) errors[name] = requiredMessage(field);
  }

  // length first: the regex is slow on very long text (the server cuts the email to 254 before this)
  if (builtins.email && (builtins.email.length > 254 || !EMAIL.test(builtins.email)) && !errors.email) {
    errors.email = "כתובת האימייל לא תקינה. לדוגמה: name@example.co.il";
  }
  // a lead needs a way back to the person
  if (!builtins.full_name && !builtins.phone && !builtins.email) {
    const target = (["full_name", "phone", "email"] as const).find((key) => visible.has(key));
    if (target && !errors[target]) errors[target] = "יש למלא שם, טלפון או אימייל.";
  }
  return { errors, builtins, custom, visible };
}

/** A message per wrong input, by input name. */
export function validatePublicForm(fields: PublicField[], values: RawValues): Record<string, string> {
  return checkSubmission(fields, values).errors;
}

/** The input an intake_submit() validation error is about (its messages are fixed in migrations 0007 and 0054). */
export function wrongField(message: string): string | undefined {
  if (message.startsWith("invalid email")) return "email";
  if (message.startsWith("a name, phone or email")) return "full_name";
  const invalidCustom = /^invalid custom field: ([a-z][a-z0-9_]{0,39})$/.exec(message);
  if (invalidCustom) return formInputName(`cf:${invalidCustom[1]}`);
  const missing = /^required field missing: (\S+)$/.exec(message);
  return missing && (isIntakeField(missing[1]) || isCustomFormKey(missing[1])) ? formInputName(missing[1]) : undefined;
}
