"use server";

import { randomBytes } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, booleanArg, directionArg, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import type { Json } from "@/lib/database.types";
import { pick } from "@/lib/validation";

import { buildCondition, sameAsStored, type FieldCondition } from "./conditions";
import { conditionBuiltinChoices } from "./condition-queries";
import { listFieldDefinitions } from "./queries";
import { createFieldSchema, updateFieldSchema } from "./schema";
import { canBeUnique, canHaveDefault, fieldSettingsProblem } from "./settings";
import { FIELD_OBJECTS, inputName, isFieldType, TYPES_WITH_OPTIONS, type FieldObject, type FieldType } from "./types";
import { parseCustomFields } from "./values";
import { saveOrder } from "@/lib/reorder";

function revalidateFields(orgId: string) {
  // the fields show in the forms and cards of every record type
  revalidatePath(paths.org(orgId), "layout");
}

/** A stable storage key that does not depend on the (Hebrew) label: f_ + 8 random characters. */
function newKey(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return `f_${[...randomBytes(8)].map((byte) => alphabet[byte % alphabet.length]).join("")}`;
}

type NewField = {
  object_type: FieldObject;
  label: string;
  field_type: FieldType;
  options: string[];
  help_text: string | null;
  is_required: boolean;
  is_unique?: boolean;
  is_read_only?: boolean;
};
type Context = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>;

/** Adds a field at the end of its object's list; the database decides who may (owners and admins) and the plan limit. */
async function insertField(context: Context, orgId: string, field: NewField): Promise<{ key: string; error: null } | { key: null; error: string }> {
  const { count } = await context.supabase
    .from("field_definitions")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("object_type", field.object_type);

  const key = newKey();
  // the plan's limit per object type is enforced by a trigger (hint limit:max_custom_fields_per_object)
  const { error } = await context.supabase.from("field_definitions").insert({
    organization_id: orgId,
    object_type: field.object_type,
    key,
    label: field.label,
    field_type: field.field_type,
    options: TYPES_WITH_OPTIONS.includes(field.field_type) ? field.options : [],
    is_required: field.is_required,
    is_unique: field.is_unique === true && canBeUnique(field.field_type),
    is_read_only: field.is_read_only === true,
    help_text: field.help_text,
    position: count ?? 0,
  });
  if (error) {
    return { key: null, error: dbErrorMessage(error, "לא הצלחנו להוסיף את השדה. נסו שוב.") };
  }
  return { key, error: null };
}

export async function createFieldAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = createFieldSchema.safeParse(pick(formData, ["label", "options", "help_text", "is_required", "is_unique", "is_read_only", "object_type", "field_type"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const created = await insertField(context, orgId, parsed.data);
  if (created.error !== null) {
    return fail(created.error, { values: formValues(formData) });
  }
  revalidateFields(orgId);
  return { ok: true, message: "השדה נוסף. הוא מופיע עכשיו בטפסים ובכרטיסים." };
}

const importFieldArgs = z.object({
  objectType: z.string(),
  label: z.string().max(1000),
  fieldType: z.string(),
  // one choice per line, as in the field settings
  options: z.string().max(20_000),
});

/**
 * IMP-01: a new field made while mapping the columns of an import. The same checks as the
 * field settings page (createFieldSchema, owners and admins only by RLS, the plan limit);
 * never required. Returns the new key, which the wizard maps the column to.
 */
export async function createImportFieldAction(
  orgId: string,
  input: { objectType: string; label: string; fieldType: string; options: string },
): Promise<ActionResult<{ key: string; label: string }>> {
  if (!validArg(importFieldArgs, input)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = createFieldSchema.safeParse({
    label: input.label,
    options: input.options,
    help_text: "",
    is_required: null,
    object_type: input.objectType,
    field_type: input.fieldType,
  });
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "השדה אינו תקין.");
  }
  // a "user" field holds a member's id, which a file does not have
  if (parsed.data.field_type === "user") {
    return fail("אי אפשר ליצור שדה מסוג משתמש מתוך ייבוא.");
  }
  const created = await insertField(context, orgId, parsed.data);
  if (created.error !== null) {
    return fail(created.error);
  }
  revalidateFields(orgId);
  return ok({ key: created.key, label: parsed.data.label });
}

export async function updateFieldAction(orgId: string, fieldId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, fieldId);
  if (!context.ok) {
    return context;
  }
  const parsed = updateFieldSchema.safeParse(pick(formData, ["label", "options", "help_text", "is_required", "is_unique", "is_read_only"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { data: field, error: fieldError } = await context.supabase
    .from("field_definitions")
    .select("field_type, key, object_type")
    .eq("organization_id", orgId)
    .eq("id", fieldId)
    .maybeSingle();
  if (fieldError) return fail(dbErrorMessage(fieldError));
  if (!field) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  if (TYPES_WITH_OPTIONS.includes(field.field_type as FieldType) && parsed.data.options.length === 0) {
    return fail("יש לכתוב לפחות אפשרות אחת, כל אחת בשורה.", {
      fieldErrors: { options: "יש לכתוב לפחות אפשרות אחת." },
      values: formValues(formData),
    });
  }
  if (!isFieldType(field.field_type)) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  const type = field.field_type;
  const withOptions = TYPES_WITH_OPTIONS.includes(type);
  // FLD-07: the default value is typed in the field's own input and read like a record's value
  let defaultValue: Json | null = null;
  if (canHaveDefault(type)) {
    const { values, errors } = parseCustomFields(
      [{ id: fieldId, key: field.key, label: parsed.data.label, type, options: withOptions ? parsed.data.options : [], isRequired: false, isActive: true, helpText: null }],
      formData,
    );
    const problem = errors[inputName(field.key)];
    if (problem) {
      return fail(problem, { fieldErrors: { [inputName(field.key)]: problem }, values: formValues(formData) });
    }
    const value = values[field.key];
    // an unticked box is "no default", not "no"
    defaultValue = value === undefined || value === null || (type === "checkbox" && value !== true) ? null : value;
  }
  const isUnique = parsed.data.is_unique && canBeUnique(type);
  const settingsProblem = fieldSettingsProblem(type, isUnique, defaultValue);
  if (settingsProblem) {
    return fail(settingsProblem, { values: formValues(formData) });
  }
  // FLD-09: the condition, when the form has its editor
  const condition = await conditionFromForm(orgId, fieldId, field.object_type, formData);
  if (!condition.ok) {
    const values = formValues(formData);
    values.condition_value = formData.getAll("condition_value").filter((v) => typeof v === "string").join("\n");
    values.condition_or_value = formData.getAll("condition_or_value").filter((v) => typeof v === "string").join("\n");
    return fail(condition.message, { fieldErrors: { condition: condition.message }, values });
  }
  const { data, error } = await context.supabase
    .from("field_definitions")
    .update({
      ...(condition.changed ? { condition: condition.value } : {}),
      label: parsed.data.label,
      help_text: parsed.data.help_text,
      is_required: parsed.data.is_required,
      is_unique: isUnique,
      is_read_only: parsed.data.is_read_only,
      default_value: defaultValue,
      ...(withOptions ? { options: parsed.data.options } : {}),
    })
    .eq("organization_id", orgId)
    .eq("id", fieldId)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את השדה. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateFields(orgId);
  return { ok: true };
}

/**
 * FLD-09: the condition the field's edit form sends (inputs condition_*), checked against the
 * fields and lists of its record type; the database checks it again. Unchanged when the form has
 * no editor, or when it repeats what is stored (a condition whose controlling field was hidden
 * since then is kept, not re-checked, so other settings can still be saved).
 */
async function conditionFromForm(
  orgId: string,
  fieldId: string,
  objectType: string,
  formData: FormData,
): Promise<{ ok: true; changed: boolean; value: FieldCondition | null } | { ok: false; message: string }> {
  if (!formData.has("condition_effect") || !(FIELD_OBJECTS as readonly string[]).includes(objectType)) {
    return { ok: true, changed: false, value: null };
  }
  const object = objectType as FieldObject;
  const text = (name: string) => {
    const value = formData.get(name);
    return typeof value === "string" ? value.trim() : "";
  };
  const input = {
    effect: text("condition_effect"),
    controller: text("condition_field"),
    op: text("condition_op"),
    choices: formData.getAll("condition_value").filter((v): v is string => typeof v === "string" && v !== ""),
    // the optional second part (a deal's pipeline beside its stage); its field follows from the first
    orOp: text("condition_or_op"),
    orChoices: formData.getAll("condition_or_value").filter((v): v is string => typeof v === "string" && v !== ""),
  };
  const definitions = await listFieldDefinitions(orgId, object, { includeInactive: true });
  const self = definitions.find((item) => item.id === fieldId);
  if (!self) return { ok: false, message: NOT_FOUND_OR_FORBIDDEN };
  if (sameAsStored(self.condition, input)) return { ok: true, changed: false, value: null };
  const builtins = await conditionBuiltinChoices(orgId, object);
  const built = buildCondition(self, definitions, object, builtins, input);
  if (!built.ok) return built;
  return { ok: true, changed: true, value: built.condition };
}

/** A hidden field disappears from forms and cards; the values already stored are kept. */
export async function setFieldActiveAction(orgId: string, fieldId: string, isActive: boolean): Promise<ActionResult> {
  if (!validArg(booleanArg, isActive)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, fieldId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase
    .from("field_definitions")
    .update({ is_active: isActive === true })
    .eq("organization_id", orgId)
    .eq("id", fieldId)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateFields(orgId);
  return ok();
}

export async function moveFieldAction(orgId: string, fieldId: string, direction: "up" | "down"): Promise<ActionResult> {
  if (!validArg(directionArg, direction)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, fieldId);
  if (!context.ok) {
    return context;
  }
  const { data: field, error: fieldError } = await context.supabase
    .from("field_definitions")
    .select("object_type")
    .eq("organization_id", orgId)
    .eq("id", fieldId)
    .maybeSingle();
  if (fieldError) return fail(dbErrorMessage(fieldError));
  if (!field) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  const { data: rows, error: rowsError } = await context.supabase
    .from("field_definitions")
    .select("id, position")
    .eq("organization_id", orgId)
    .eq("object_type", field.object_type)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (rowsError) return fail(dbErrorMessage(rowsError));
  const ordered = rows ?? [];
  const index = ordered.findIndex((row) => row.id === fieldId);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= ordered.length) {
    return ok();
  }
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  // FXD-07: the whole order in one call
  const orderError = await saveOrder(context.supabase, "field_definitions", orgId, ordered.map((row) => row.id));
  if (orderError) {
    return fail(orderError);
  }
  revalidateFields(orgId);
  return ok();
}
