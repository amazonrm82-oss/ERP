"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { siteOrigin } from "@/lib/site-origin";

import { publicStatementPath, STATEMENT_LINK_TOKEN } from "./public";

// BAL-04: the customer's statement link, with the user's session. The database decides who may (whoever records payments,
// with the ledger's keys, never while part of the customer's money is hidden from them) and for which customer (a contact
// without a company, or a company; not in the recycle bin).

export type StatementCustomer = { kind: "contact" | "company"; id: string };

const CANNOT = "אין לכם הרשאה לנהל את הקישור לדף החשבון של הלקוח הזה.";
const writeError = (error: { code?: string; message?: string; hint?: string }) => (error.code === "42501" ? CANNOT : dbErrorMessage(error));
const args = (orgId: string, customer: StatementCustomer) => ({
  p_org: orgId,
  p_contact: customer.kind === "contact" ? customer.id : null,
  p_company: customer.kind === "company" ? customer.id : null,
});
const pagePath = (orgId: string, customer: StatementCustomer) => (customer.kind === "contact" ? paths.contact(orgId, customer.id) : paths.company(orgId, customer.id));
const validKind = (customer: StatementCustomer) => customer.kind === "contact" || customer.kind === "company";

/** A new link (public.statement_link_create). The address is returned once: only its hash is kept; the previous link stops. */
export async function createStatementLinkAction(orgId: string, customer: StatementCustomer): Promise<ActionResult<{ url: string }>> {
  if (!validKind(customer)) return fail("הבקשה אינה תקינה.");
  const context = await actionContext(orgId, customer.id);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("statement_link_create", args(orgId, customer));
  if (error) return fail(writeError(error));
  if (typeof data !== "string" || !STATEMENT_LINK_TOKEN.test(data)) return fail("לא הצלחנו ליצור קישור. נסו שוב.");
  revalidatePath(pagePath(orgId, customer));
  return ok({ url: `${await siteOrigin()}${publicStatementPath(data)}` });
}

/** Turns the customer's link off; the page answers "not found" from now on. */
export async function revokeStatementLinkAction(orgId: string, customer: StatementCustomer): Promise<ActionResult> {
  if (!validKind(customer)) return fail("הבקשה אינה תקינה.");
  const context = await actionContext(orgId, customer.id);
  if (!context.ok) return context;
  const { error } = await context.supabase.rpc("statement_link_revoke", args(orgId, customer));
  if (error) return fail(writeError(error));
  revalidatePath(pagePath(orgId, customer));
  return ok();
}
