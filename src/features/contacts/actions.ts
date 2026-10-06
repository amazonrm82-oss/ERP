"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { customFieldsFromForm, customFieldsPatch } from "@/features/custom-fields/server";
import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { setTrashed } from "@/lib/record-trash";
import { pick } from "@/lib/validation";

import { CONTACT_FIELD_NAMES, contactSchema } from "./schema";

function revalidateContact(orgId: string, contactId?: string) {
  revalidatePath(paths.contacts(orgId));
  if (contactId) {
    revalidatePath(paths.contact(orgId, contactId));
  }
}

export async function createContactAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = contactSchema.safeParse(pick(formData, CONTACT_FIELD_NAMES));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  const custom = await customFieldsFromForm(context.supabase, orgId, "contact", formData);
  if (!custom.ok) {
    return custom;
  }

  // owner_id is left out: the database assigns the contact to its creator.
  // A company id from another organization fails the composite foreign key.
  const { data, error } = await context.supabase
    .from("contacts")
    .insert({ organization_id: orgId, ...parsed.data, ...customFieldsPatch(custom.customFields) })
    .select("id")
    .single();
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו ליצור את איש הקשר. נסו שוב."), { values: formValues(formData) });
  }

  revalidateContact(orgId);
  redirect(paths.contact(orgId, data.id));
}

export async function updateContactAction(
  orgId: string,
  contactId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const context = await actionContext(orgId, contactId);
  if (!context.ok) {
    return context;
  }
  const parsed = contactSchema.safeParse(pick(formData, CONTACT_FIELD_NAMES));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  const custom = await customFieldsFromForm(context.supabase, orgId, "contact", formData, contactId);
  if (!custom.ok) {
    return custom;
  }

  const { data, error } = await context.supabase
    .from("contacts")
    .update({ ...parsed.data, ...customFieldsPatch(custom.customFields) })
    .eq("organization_id", orgId)
    .eq("id", contactId)
    .is("deleted_at", null)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את השינויים. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  }

  revalidateContact(orgId, contactId);
  revalidatePath(paths.companies(orgId), "layout");
  return { ok: true };
}

/** Moves the contact to the recycle bin. Its deals stay and keep pointing at it. */
export async function trashContactAction(orgId: string, contactId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, contactId);
  if (!context.ok) {
    return context;
  }
  const result = await setTrashed(context.supabase, "contacts", orgId, contactId, true);
  if (!result.ok) {
    return result;
  }
  revalidateContact(orgId, contactId);
  redirect(paths.contacts(orgId));
}
