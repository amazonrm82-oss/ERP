"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { createIntakeSchema, fieldsFromForm, updateIntakeSchema } from "./schema";

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
    ]),
  );
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { data: current } = await context.supabase.from("forms").select("kind").eq("organization_id", orgId).eq("id", formId).maybeSingle();
  if (!current) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  const fields = fieldsFromForm(formData);
  if (current.kind === "form" && !fields.some((field) => ["full_name", "phone", "email"].includes(field.key))) {
    return fail("הטופס צריך לבקש לפחות אחד: שם, טלפון או אימייל.", { values: formValues(formData) });
  }

  const { data, error } = await context.supabase
    .from("forms")
    .update({ ...parsed.data, ...(current.kind === "form" ? { fields } : {}) })
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

/** Deletes the form or webhook with its submission log. Leads it created stay. */
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
