"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { actionContext } from "@/lib/action-context";
import { fail, FORM_INVALID, formValues, invalid, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { isFieldType, type FieldType } from "@/features/custom-fields/types";
import type { Json } from "@/lib/database.types";

import { formFieldOptions, storedFields } from "./fields";
import { createIntakeSchema, fieldsFromForm, updateIntakeSchema } from "./schema";
import { whatsappNumber } from "./whatsapp";

export async function createIntakeAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = createIntakeSchema.safeParse(pick(formData, ["name", "kind"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  // leads of a new web form go to the person who made it, until changed
  const { data, error } = await context.supabase
    .from("forms")
    .insert({
      organization_id: orgId,
      kind: parsed.data.kind,
      name: parsed.data.name,
      title: parsed.data.kind === "form" ? parsed.data.name : null,
      owner_id: context.user.id,
    })
    .select("id")
    .single();
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו ליצור. נסו שוב."), { values: formValues(formData) });
  }
  revalidatePath(paths.settingsIntake(orgId));
  redirect(paths.settingsIntakeItem(orgId, data.id));
}

export async function updateIntakeAction(orgId: string, formId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, formId);
  if (!context.ok) {
    return context;
  }
  const parsed = updateIntakeSchema.safeParse(
    pick(formData, [
      "name",
      "title",
      "intro",
      "submit_label",
      "success_message",
      "redirect_url",
      "source_id",
      "owner_id",
      "team_id",
      "assign_mode",
      "is_active",
      "whatsapp_button",
      "whatsapp_phone",
      "whatsapp_text",
      "callback_choice",
    ]),
  );
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { data: current, error: currentError } = await context.supabase.from("forms").select("kind").eq("organization_id", orgId).eq("id", formId).maybeSingle();
  if (currentError) return fail(dbErrorMessage(currentError));
  if (!current) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  let fields: Json | undefined;
  if (current.kind === "form") {
    // CAP-01: the builder's fields, checked against the business's lead fields
    const { data: definitions, error: definitionsError } = await context.supabase
      .from("field_definitions")
      .select("key, label, field_type, options, is_active")
      .eq("organization_id", orgId)
      .eq("object_type", "lead");
    if (definitionsError) return fail(dbErrorMessage(definitionsError));
    const options = formFieldOptions(
      definitions
        .filter((row) => isFieldType(row.field_type))
        .map((row) => ({
          id: row.key,
          key: row.key,
          label: row.label,
          type: row.field_type as FieldType,
          options: Array.isArray(row.options) ? row.options.filter((o): o is string => typeof o === "string") : [],
          isRequired: false,
          isActive: row.is_active,
          helpText: null,
        })),
    );
    const checked = fieldsFromForm(formData, options);
    if (!checked.ok) {
      return fail(checked.message, { values: formValues(formData) });
    }
    fields = storedFields(checked.fields);
  }
  // CAP-05: the WhatsApp button needs a number: the form's own, else the business phone
  if (current.kind === "form" && parsed.data.whatsapp_button && !parsed.data.whatsapp_phone) {
    const { data: org, error: orgError } = await context.supabase.from("organizations").select("phone").eq("id", orgId).maybeSingle();
    if (orgError) return fail(dbErrorMessage(orgError));
    if (!whatsappNumber(org?.phone)) {
      return fail(FORM_INVALID, {
        values: formValues(formData),
        fieldErrors: { whatsapp_phone: "יש להזין מספר ל-WhatsApp: בפרטי העסק אין מספר טלפון תקין." },
      });
    }
  }

  // CAP-05: webhooks keep their WhatsApp columns as they are; with the button off
  // only the switch is saved, and the stored number and text stay untouched
  const { whatsapp_button, whatsapp_phone, whatsapp_text, callback_choice, ...settings } = parsed.data;
  const thanks =
    current.kind !== "form" ? {} : whatsapp_button ? { whatsapp_button, whatsapp_phone, whatsapp_text } : { whatsapp_button };
  // SPD-05: a webhook has no form to ask on; its switch stays as it is
  const formOnly = current.kind === "form" ? { callback_choice } : {};
  const { data, error } = await context.supabase
    .from("forms")
    .update({ ...settings, ...thanks, ...formOnly, ...(fields !== undefined ? { fields } : {}) })
    .eq("organization_id", orgId)
    .eq("id", formId)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(paths.settingsIntake(orgId));
  revalidatePath(paths.settingsIntakeItem(orgId, formId));
  return { ok: true, message: "נשמר." };
}

/** Deletes the form or webhook. Leads it created and its submission log stay (CAP-04). */
export async function deleteIntakeAction(orgId: string, formId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, formId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase.from("forms").delete().eq("organization_id", orgId).eq("id", formId).select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(paths.settingsIntake(orgId));
  redirect(paths.settingsIntake(orgId));
}
