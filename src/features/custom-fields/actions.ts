"use server";

import { randomBytes } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, booleanArg, directionArg, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { createFieldSchema, updateFieldSchema } from "./schema";
import { TYPES_WITH_OPTIONS, type FieldObject, type FieldType } from "./types";

function revalidateFields(orgId: string) {
  // the fields show in the forms and cards of every record type
  revalidatePath(paths.org(orgId), "layout");
}

/** A stable storage key that does not depend on the (Hebrew) label: f_ + 8 random characters. */
function newKey(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return `f_${[...randomBytes(8)].map((byte) => alphabet[byte % alphabet.length]).join("")}`;
}

type NewField = { object_type: FieldObject; label: string; field_type: FieldType; options: string[]; help_text: string | null; is_required: boolean };
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
  const parsed = createFieldSchema.safeParse(pick(formData, ["label", "options", "help_text", "is_required", "object_type", "field_type"]));
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
  const parsed = updateFieldSchema.safeParse(pick(formData, ["label", "options", "help_text", "is_required"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { data: field, error: fieldError } = await context.supabase
    .from("field_definitions")
    .select("field_type")
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
  const { data, error } = await context.supabase
    .from("field_definitions")
    .update({
      label: parsed.data.label,
      help_text: parsed.data.help_text,
      is_required: parsed.data.is_required,
      ...(TYPES_WITH_OPTIONS.includes(field.field_type as FieldType) ? { options: parsed.data.options } : {}),
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
  for (const [position, row] of ordered.entries()) {
    if (row.position !== position) {
      const { error } = await context.supabase.from("field_definitions").update({ position }).eq("organization_id", orgId).eq("id", row.id);
      if (error) {
        return fail(dbErrorMessage(error));
      }
    }
  }
  revalidateFields(orgId);
  return ok();
}
