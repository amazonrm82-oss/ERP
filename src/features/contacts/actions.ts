"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { customFieldsFromForm, customFieldsPatch } from "@/features/custom-fields/server";
import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { setTrashed } from "@/lib/record-trash";
import { typeIdFromForm } from "@/features/record-type-options/schema";
import type { ContactEmailType, ContactPhoneType } from "@/lib/database.types";
import { pick } from "@/lib/validation";

import { parseChannels, planChannels, type ParsedChannels, type StoredChannel } from "./channels";
import { CONTACT_FIELD_NAMES, contactSchema } from "./schema";

type Supabase = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>["supabase"];

/**
 * CON-01: the phones and emails the form sent. The primary of each goes to the contact's
 * own columns (and through the same checks as before); the rest become further rows.
 */
function readContact(formData: FormData) {
  const phones = parseChannels("phone", formData.get("phones"));
  const emails = parseChannels("email", formData.get("emails"));
  if (!phones.ok || !emails.ok) {
    const fieldErrors: Record<string, string> = {};
    if (!phones.ok) fieldErrors.phones = phones.message;
    if (!emails.ok) fieldErrors.emails = emails.message;
    return { ok: false as const, failure: fail(fieldErrors.phones ?? fieldErrors.emails, { fieldErrors, values: formValues(formData) }) };
  }
  const input = {
    ...pick(formData, CONTACT_FIELD_NAMES),
    phone: phones.value.primary?.value ?? "",
    email: emails.value.primary?.value ?? "",
  };
  const parsed = contactSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, failure: invalid(parsed.error, formData) };
  }
  return {
    ok: true as const,
    data: {
      ...parsed.data,
      phone_type: (phones.value.primary?.type ?? null) as ContactPhoneType | null,
      email_type: (emails.value.primary?.type ?? null) as ContactEmailType | null,
    },
    phones: phones.value,
    emails: emails.value,
  };
}

/** Brings the stored further phones and emails to the wanted lists, with the user's session. */
async function saveExtraChannels(
  supabase: Supabase,
  orgId: string,
  contactId: string,
  phones: ParsedChannels,
  emails: ParsedChannels,
  stored: StoredChannel[],
): Promise<string | null> {
  const plans = [planChannels("phone", stored, phones.extras), planChannels("email", stored, emails.extras)];
  const remove = plans.flatMap((p) => p.remove);
  if (remove.length) {
    const { data, error } = await supabase.from("contact_channels").delete().eq("organization_id", orgId).eq("contact_id", contactId).in("id", remove).select("id");
    if (error) return dbErrorMessage(error);
    if (data.length !== remove.length) return NOT_FOUND_OR_FORBIDDEN;
  }
  for (const change of plans.flatMap((p) => p.update)) {
    const { data, error } = await supabase
      .from("contact_channels")
      .update({ label: change.label as ContactPhoneType, position: change.position })
      .eq("organization_id", orgId)
      .eq("id", change.id)
      .select("id");
    if (error) return dbErrorMessage(error);
    if (data.length === 0) return NOT_FOUND_OR_FORBIDDEN;
  }
  const insert = plans.flatMap((p) => p.insert);
  if (insert.length) {
    const { error } = await supabase
      .from("contact_channels")
      .insert(insert.map((row) => ({ organization_id: orgId, contact_id: contactId, kind: row.kind, label: row.label as ContactPhoneType, value: row.value, position: row.position })));
    if (error) return dbErrorMessage(error);
  }
  return null;
}

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
  const parsed = readContact(formData);
  if (!parsed.ok) {
    return parsed.failure;
  }

  const custom = await customFieldsFromForm(orgId, "contact", formData);
  if (!custom.ok) {
    return custom;
  }
  // CON-02: only when the form has the field (the organization has types)
  const type = typeIdFromForm(formData);
  if (!type.ok) {
    return fail(type.message, { fieldErrors: { type_id: type.message }, values: formValues(formData) });
  }

  // owner_id is left out: the database assigns the contact to its creator.
  // A company id from another organization fails the composite foreign key.
  const { data, error } = await context.supabase
    .from("contacts")
    .insert({ organization_id: orgId, ...parsed.data, ...type.patch, ...customFieldsPatch(custom.customFields) })
    .select("id")
    .single();
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו ליצור את איש הקשר. נסו שוב."), { values: formValues(formData) });
  }
  // the contact exists now, so the form is not shown again (sending it twice would make a second
  // contact); if further phones or emails failed, its page says so
  const channelError = await saveExtraChannels(context.supabase, orgId, data.id, parsed.phones, parsed.emails, []);

  revalidateContact(orgId);
  redirect(channelError ? `${paths.contact(orgId, data.id)}?channels=failed` : paths.contact(orgId, data.id));
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
  const parsed = readContact(formData);
  if (!parsed.ok) {
    return parsed.failure;
  }

  const custom = await customFieldsFromForm(orgId, "contact", formData, contactId);
  if (!custom.ok) {
    return custom;
  }
  // CON-02: only when the form has the field (the organization has types)
  const type = typeIdFromForm(formData);
  if (!type.ok) {
    return fail(type.message, { fieldErrors: { type_id: type.message }, values: formValues(formData) });
  }

  const { data, error } = await context.supabase
    .from("contacts")
    .update({ ...parsed.data, ...type.patch, ...customFieldsPatch(custom.customFields) })
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

  // CON-01: the further phones and emails, after the contact (whose primary values may have moved)
  const { data: stored, error: storedError } = await context.supabase
    .from("contact_channels")
    .select("id, kind, label, value, value_e164, position")
    .eq("organization_id", orgId)
    .eq("contact_id", contactId);
  const channelError = storedError
    ? dbErrorMessage(storedError)
    : await saveExtraChannels(context.supabase, orgId, contactId, parsed.phones, parsed.emails, stored as StoredChannel[]);
  if (channelError) {
    revalidateContact(orgId, contactId);
    return fail(`הפרטים נשמרו, אבל לא כל הטלפונים והאימיילים הנוספים: ${channelError}`, { values: formValues(formData) });
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
