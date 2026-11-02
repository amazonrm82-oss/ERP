import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { must } from "@/lib/db-read";

import type { BundlePartSnapshot } from "./bundle";
import type { ProductPrice } from "./price";
import type { VatKind } from "./schema";

type Client = SupabaseClient<Database>;

// PRD-09: the parts of bundles, read with the user's session (members read them; the catalog's rights write them).

export type BundlePart = {
  id: string;
  componentId: string;
  name: string;
  sku: string | null;
  quantity: number;
  unitName: string | null;
  price: ProductPrice;
  // the part was archived or switched off after it was added (it stays in the bundle)
  offerable: boolean;
};

/** The parts of one bundle in order, with each part's product (at most 50, app.product_bundle_items_check). */
export async function readBundleParts(supabase: Client, orgId: string, bundleId: string): Promise<BundlePart[]> {
  const rows = must(
    await supabase
      .from("product_bundle_items")
      .select("id, component_id, quantity, position")
      .eq("organization_id", orgId)
      .eq("bundle_id", bundleId)
      .order("position")
      .order("created_at")
      .order("id"),
    "product_bundle_items",
  );
  if (rows.length === 0) return [];
  const products = must(
    await supabase
      .from("products")
      .select("id, name, sku, unit_id, price_agorot, price_includes_vat, vat_kind, is_active, archived_at")
      .eq("organization_id", orgId)
      .in(
        "id",
        rows.map((row) => row.component_id),
      ),
    "products",
  );
  const unitIds = [...new Set(products.map((p) => p.unit_id).filter((id): id is string => id !== null))];
  const units =
    unitIds.length === 0 ? [] : must(await supabase.from("product_units").select("id, name").eq("organization_id", orgId).in("id", unitIds), "product_units");
  const parts: BundlePart[] = [];
  for (const row of rows) {
    const product = products.find((p) => p.id === row.component_id);
    if (!product) continue;
    parts.push({
      id: row.id,
      componentId: product.id,
      name: product.name,
      sku: product.sku,
      quantity: Number(row.quantity),
      unitName: units.find((u) => u.id === product.unit_id)?.name ?? null,
      // the check constraint holds vat_kind to VAT_KINDS
      price: { priceAgorot: Number(product.price_agorot), priceIncludesVat: product.price_includes_vat, vatKind: product.vat_kind as VatKind },
      offerable: product.is_active && product.archived_at === null,
    });
  }
  return parts;
}

/** The parts of several bundles as they are now (names and quantities per one bundle), for lines that show them live. */
export async function readBundleSnapshots(supabase: Client, orgId: string, bundleIds: string[]): Promise<Map<string, BundlePartSnapshot[]>> {
  const result = new Map<string, BundlePartSnapshot[]>();
  const ids = [...new Set(bundleIds)];
  if (ids.length === 0) return result;
  const rows = must(
    await supabase
      .from("product_bundle_items")
      .select("bundle_id, component_id, quantity, position")
      .eq("organization_id", orgId)
      .in("bundle_id", ids)
      .order("position")
      .order("created_at")
      .order("id"),
    "product_bundle_items",
  );
  if (rows.length === 0) return result;
  const products = must(
    await supabase
      .from("products")
      .select("id, name, unit_id")
      .eq("organization_id", orgId)
      .in("id", [...new Set(rows.map((row) => row.component_id))]),
    "products",
  );
  const unitIds = [...new Set(products.map((p) => p.unit_id).filter((id): id is string => id !== null))];
  const units =
    unitIds.length === 0 ? [] : must(await supabase.from("product_units").select("id, name").eq("organization_id", orgId).in("id", unitIds), "product_units");
  for (const row of rows) {
    const product = products.find((p) => p.id === row.component_id);
    if (!product) continue;
    const list = result.get(row.bundle_id) ?? [];
    list.push({ name: product.name, quantity: Number(row.quantity), unitName: units.find((u) => u.id === product.unit_id)?.name ?? null });
    result.set(row.bundle_id, list);
  }
  return result;
}

/**
 * A copy of a bundle (PRD-02's copy) gets the same parts, one by one with the user's session; a part the rules no longer
 * take (archived, switched off) is left out. Never throws: the copy itself is made already.
 */
export async function copyBundleParts(supabase: Client, orgId: string, fromId: string, toId: string): Promise<void> {
  const { data, error } = await supabase
    .from("product_bundle_items")
    .select("component_id, quantity, position")
    .eq("organization_id", orgId)
    .eq("bundle_id", fromId)
    .order("position")
    .order("id");
  if (error || !data) return;
  for (const row of data) {
    await supabase
      .from("product_bundle_items")
      .insert({ organization_id: orgId, bundle_id: toId, component_id: row.component_id, quantity: Number(row.quantity), position: row.position });
  }
}
