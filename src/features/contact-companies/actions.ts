"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { addContactCompanySchema, CONTACT_COMPANY_FIELD_NAMES, titleArg } from "./schema";

const ALREADY_LINKED = "איש הקשר כבר מקושר לחברה הזו.";
const CANNOT_LINK = "אי אפשר לקשר את החברה. ייתכן שהיא או איש הקשר בסל המחזור, שאין לכם גישה אליה, או שאין לכם הרשאה לערוך את איש הקשר.";

function revalidateLink(orgId: string, contactId: string, companyId: string | null) {
  revalidatePath(paths.contact(orgId, contactId));
  if (companyId) {
    revalidatePath(paths.company(orgId, companyId));
  }
}

/** CON-05: link a contact to one more company, with an optional role there. Rights follow the contact (RLS). */
export async function addContactCompanyAction(orgId: string, contactId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, contactId);
  if (!context.ok) {
    return context;
  }
  const parsed = addContactCompanySchema.safeParse(pick(formData, CONTACT_COMPANY_FIELD_NAMES));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { error } = await context.supabase.from("contact_companies").insert({
    organization_id: orgId,
    contact_id: contactId,
    company_id: parsed.data.company_id,
    title: parsed.data.title,
  });
  if (error) {
    const message = error.code === "23505" ? ALREADY_LINKED : error.code === "42501" ? CANNOT_LINK : dbErrorMessage(error);
    return fail(message, { values: formValues(formData) });
  }
  revalidateLink(orgId, contactId, parsed.data.company_id);
  return ok();
}

/** CON-05: change (or clear) the contact's role at a company. */
export async function setContactCompanyTitleAction(orgId: string, contactId: string, linkId: string, title: unknown): Promise<ActionResult> {
  const context = await actionContext(orgId, contactId, linkId);
  if (!context.ok) {
    return context;
  }
  if (!validArg(titleArg, title)) {
    return fail(INVALID_ARGS);
  }
  const { data, error } = await context.supabase
    .from("contact_companies")
    .update({ title: titleArg.parse(title) })
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .eq("id", linkId)
    .select("company_id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateLink(orgId, contactId, data[0].company_id);
  return ok();
}

/** CON-05: make a further company the contact's primary one (contacts.company_id; the links follow it). */
export async function makePrimaryCompanyAction(orgId: string, contactId: string, companyId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, contactId, companyId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase
    .from("contacts")
    .update({ company_id: companyId })
    .eq("organization_id", orgId)
    .eq("id", contactId)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateLink(orgId, contactId, companyId);
  return ok();
}

/**
 * CON-05: take a company off the contact. The company itself stays. The primary company is first cleared on the
 * contact (only while it is still that company), then its link goes like any other.
 */
export async function removeContactCompanyAction(orgId: string, contactId: string, linkId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, contactId, linkId);
  if (!context.ok) {
    return context;
  }
  const { data: rows, error: readError } = await context.supabase
    .from("contact_companies")
    .select("company_id, is_primary")
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .eq("id", linkId);
  if (readError) {
    return fail(dbErrorMessage(readError));
  }
  const link = rows[0];
  if (!link) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  if (link.is_primary) {
    const { data, error } = await context.supabase
      .from("contacts")
      .update({ company_id: null })
      .eq("organization_id", orgId)
      .eq("id", contactId)
      .eq("company_id", link.company_id)
      .select("id");
    if (error) {
      return fail(dbErrorMessage(error));
    }
    if (data.length === 0) {
      return fail(NOT_FOUND_OR_FORBIDDEN);
    }
  }
  const { data, error } = await context.supabase
    .from("contact_companies")
    .delete()
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .eq("id", linkId)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateLink(orgId, contactId, link.company_id);
  return ok();
}
