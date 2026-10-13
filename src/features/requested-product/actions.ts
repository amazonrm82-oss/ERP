"use server";

import { actionContext } from "@/lib/action-context";
import { optionalTextArg, validArg } from "@/lib/action-args";
import { ilikeAny } from "@/lib/search";

import type { RequestedProductHit } from "./queries";

/**
 * LEAD-04: offerable products (active, not archived) for the requested product picker, by name:
 * the first 20, or those whose name or SKU matches the query. Read with the user's session.
 */
export async function searchRequestedProductsAction(orgId: string, query: string): Promise<RequestedProductHit[]> {
  if (!validArg(optionalTextArg(100), query) || typeof query !== "string") {
    return [];
  }
  const context = await actionContext(orgId);
  if (!context.ok) {
    return [];
  }
  let request = context.supabase
    .from("products")
    .select("id, name, sku")
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .is("archived_at", null);
  const q = query.trim();
  if (q !== "") {
    const filter = ilikeAny(["name", "sku"], q);
    if (!filter) return [];
    request = request.or(filter);
  }
  const { data, error } = await request.order("name", { ascending: true }).order("id").limit(20);
  if (error) {
    return [];
  }
  return data;
}
