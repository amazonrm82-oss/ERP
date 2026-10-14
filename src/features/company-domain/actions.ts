"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";

/**
 * CON-09: removes a company link made by the email domain. Only while the contact still points at
 * that company, so a link someone changed meanwhile is left alone. A normal company_id change with
 * the user's session (RLS decides; the audit log records it; the database clears the domain mark).
 */
export async function removeDomainCompanyAction(orgId: string, contactId: string, companyId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, contactId, companyId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("contacts")
    .update({ company_id: null })
    .eq("organization_id", orgId)
    .eq("id", contactId)
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו להסיר את השיוך."));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(paths.contact(orgId, contactId));
  return ok();
}

/** CON-09: links a contact without a company to one of the companies that share its email domain. */
export async function pickDomainCompanyAction(orgId: string, contactId: string, companyId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, contactId, companyId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("contacts")
    .update({ company_id: companyId })
    .eq("organization_id", orgId)
    .eq("id", contactId)
    .is("company_id", null)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו לשייך לחברה."));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(paths.contact(orgId, contactId));
  return ok();
}

/**
 * CON-09: switches the domain a company gets from its contacts' emails off (true) or back on (null).
 * A normal company update with the user's session: whoever may edit the company; audited.
 */
export async function setContactDomainAction(orgId: string, companyId: string, off: boolean): Promise<ActionResult> {
  if (!validArg(z.boolean(), off)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, companyId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("companies")
    .update({ contact_domain_off: off ? true : null })
    .eq("organization_id", orgId)
    .eq("id", companyId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו לשמור."));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(paths.company(orgId, companyId));
  return ok();
}
