"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { addDealContactSchema, DEAL_CONTACT_FIELD_NAMES, dealContactRoleArg } from "./schema";

const ALREADY_LINKED = "איש הקשר כבר נמצא בעסקה.";
const CANNOT_LINK = "אי אפשר להוסיף את איש הקשר. ייתכן שהוא בסל המחזור, שאין לכם גישה אליו, או שאין לכם הרשאה לערוך את העסקה.";

function revalidateLink(orgId: string, dealId: string, contactId: string) {
  revalidatePath(paths.deal(orgId, dealId));
  revalidatePath(paths.contact(orgId, contactId));
}

/** CON-03: add a contact to a deal, with an optional role. Rights follow the deal (RLS). */
export async function addDealContactAction(orgId: string, dealId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, dealId);
  if (!context.ok) {
    return context;
  }
  const parsed = addDealContactSchema.safeParse(pick(formData, DEAL_CONTACT_FIELD_NAMES));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { error } = await context.supabase.from("deal_contacts").insert({
    organization_id: orgId,
    deal_id: dealId,
    contact_id: parsed.data.contact_id,
    role_id: parsed.data.role_id,
  });
  if (error) {
    const message = error.code === "23505" ? ALREADY_LINKED : error.code === "42501" ? CANNOT_LINK : dbErrorMessage(error);
    return fail(message, { values: formValues(formData) });
  }
  revalidateLink(orgId, dealId, parsed.data.contact_id);
  return ok();
}

/** CON-03: change (or clear) the role of a contact in a deal. The old code of a link saved before the list goes with it. */
export async function setDealContactRoleAction(orgId: string, dealId: string, contactId: string, role: unknown): Promise<ActionResult> {
  const context = await actionContext(orgId, dealId, contactId);
  if (!context.ok) {
    return context;
  }
  const parsed = dealContactRoleArg.safeParse(role);
  if (!parsed.success) {
    return fail(INVALID_ARGS);
  }
  const { data, error } = await context.supabase
    .from("deal_contacts")
    .update({ role_id: parsed.data, role: null })
    .eq("organization_id", orgId)
    .eq("deal_id", dealId)
    .eq("contact_id", contactId)
    .select("contact_id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateLink(orgId, dealId, contactId);
  return ok();
}

/** CON-03: take a contact off a deal. The contact itself stays. */
export async function removeDealContactAction(orgId: string, dealId: string, contactId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, dealId, contactId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase
    .from("deal_contacts")
    .delete()
    .eq("organization_id", orgId)
    .eq("deal_id", dealId)
    .eq("contact_id", contactId)
    .select("contact_id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateLink(orgId, dealId, contactId);
  return ok();
}
