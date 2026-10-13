import "server-only";

import { orgHasFeature } from "@/features/settings/queries";
import { must } from "@/lib/db-read";
import { readAllPagesByIds } from "@/lib/paged-read";
import { createClient } from "@/lib/supabase/server";

import { requestedProductNote } from "./schema";

export type RequestedProductHit = { id: string; name: string; sku: string | null };

export type RequestedProduct = { id: string; name: string; note: string | null };

/** LEAD-04: whether lead forms show the requested product (the plan flag 'products'). */
export function requestedProductEnabled(orgId: string): Promise<boolean> {
  return orgHasFeature(orgId, "products");
}

/** The lead's requested product with its state, read with the user's session; null when none or not readable. */
export async function getRequestedProduct(orgId: string, productId: string | null): Promise<RequestedProduct | null> {
  if (!productId) return null;
  const supabase = await createClient();
  const row = must(
    await supabase.from("products").select("id, name, is_active, archived_at").eq("organization_id", orgId).eq("id", productId).maybeSingle(),
    "products",
  );
  if (!row) return null;
  return { id: row.id, name: row.name, note: requestedProductNote({ isActive: row.is_active, archivedAt: row.archived_at }) };
}

/** Product names by id, for a page of leads (paged by ids: an export chunk may hold many). */
export async function requestedProductNames(orgId: string, ids: ReadonlyArray<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const supabase = await createClient();
  const rows = await readAllPagesByIds(wanted, async (slice, from, to) =>
    must(await supabase.from("products").select("id, name").eq("organization_id", orgId).in("id", slice).order("id").range(from, to), "products"),
  );
  return new Map(rows.map((row) => [row.id, row.name]));
}
