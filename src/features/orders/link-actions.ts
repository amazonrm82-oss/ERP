"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { siteOrigin } from "@/lib/site-origin";

import { orderPath } from "./paths";
import { ORDER_LINK_TOKEN, publicOrderPath } from "./public";

// ORD-05: the customer's link to a numbered order, with the user's session. The database decides who may (whoever may edit
// the order, in a business with orders) and which orders get one (numbered, not cancelled, customer not deleted).

const CANNOT = "אין לכם הרשאה לנהל את הקישור של ההזמנה הזו.";
const writeError = (error: { code?: string; message?: string; hint?: string }) => (error.code === "42501" ? CANNOT : dbErrorMessage(error));

/** A new link (public.order_link_create). The address is returned once: only its hash is kept; the previous link stops. */
export async function createOrderLinkAction(orgId: string, orderId: string): Promise<ActionResult<{ url: string }>> {
  const context = await actionContext(orgId, orderId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("order_link_create", { p_org: orgId, p_order: orderId });
  if (error) return fail(writeError(error));
  if (typeof data !== "string" || !ORDER_LINK_TOKEN.test(data)) return fail("לא הצלחנו ליצור קישור. נסו שוב.");
  revalidatePath(orderPath(orgId, orderId));
  return ok({ url: `${await siteOrigin()}${publicOrderPath(data)}` });
}

/** Turns the customer's link off; the page answers "not found" from now on. */
export async function revokeOrderLinkAction(orgId: string, orderId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, orderId);
  if (!context.ok) return context;
  const { error } = await context.supabase.rpc("order_link_revoke", { p_org: orgId, p_order: orderId });
  if (error) return fail(writeError(error));
  revalidatePath(orderPath(orgId, orderId));
  return ok();
}
