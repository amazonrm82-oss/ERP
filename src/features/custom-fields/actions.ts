"use server";

import { randomBytes } from "node:crypto";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { createFieldSchema, updateFieldSchema } from "./schema";

function revalidateFields(orgId: string) {
  // the fields show in the forms and cards of every record type
  revalidatePath(paths.org(orgId), "layout");
}

/** A stable storage key that does not depend on the (Hebrew) label: f_ + 8 random characters. */
function newKey(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return `f_${[...randomBytes(8)].map((byte) => alphabet[byte % alphabet.length]).join("")}`;
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
  const { count } = await context.supabase
    .from("field_definitions")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("object_type", parsed.data.object_type);

  // the plan's limit per object type is enforced by a trigger (hint limit:max_custom_fields_per_object)
  const { error } = await context.supabase.from("field_definitions").insert({
    organization_id: orgId,
    object_type: parsed.data.object_type,
    key: newKey(),
    label: parsed.data.label,
    field_type: parsed.data.field_type,
    options: parsed.data.field_type === "select" ? parsed.data.options : [],
    is_required: parsed.data.is_required,
    help_text: parsed.data.help_text,
    position: count ?? 0,
  });
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו להוסיף את השדה. נסו שוב."), { values: formValues(formData) });
  }
  revalidateFields(orgId);
  return { ok: true, message: "השדה נוסף. הוא מופיע עכשיו בטפסים ובכרטיסים." };
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
  const { data: field } = await context.supabase
    .from("field_definitions")
    .select("field_type")
    .eq("organization_id", orgId)
    .eq("id", fieldId)
    .maybeSingle();
  if (!field) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  if (field.field_type === "select" && parsed.data.options.length === 0) {
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
      ...(field.field_type === "select" ? { options: parsed.data.options } : {}),
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
  const context = await actionContext(orgId, fieldId);
  if (!context.ok) {
    return context;
  }
  const { data: field } = await context.supabase
    .from("field_definitions")
    .select("object_type")
    .eq("organization_id", orgId)
    .eq("id", fieldId)
    .maybeSingle();
  if (!field) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  const { data: rows } = await context.supabase
    .from("field_definitions")
    .select("id, position")
    .eq("organization_id", orgId)
    .eq("object_type", field.object_type)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
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
