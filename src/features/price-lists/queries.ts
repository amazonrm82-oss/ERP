import "server-only";

import type { VatKind } from "@/features/products/schema";
import { must } from "@/lib/db-read";
import { readAllPages, readAllPagesByIds } from "@/lib/paged-read";
import { createClient } from "@/lib/supabase/server";

import type { PriceListLineRule } from "./price";

export type PriceList = {
  id: string;
  name: string;
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
  // every price in the list is typed and shown in this mode (owner, 13 October 2026)
  pricesIncludeVat: boolean;
  createdAt: string;
};

type Row = {
  id: string;
  name: string;
  valid_from: string | null;
  valid_to: string | null;
  is_active: boolean;
  prices_include_vat: boolean;
  created_at: string;
};

const COLUMNS = "id, name, valid_from, valid_to, is_active, prices_include_vat, created_at";

function toPriceList(row: Row): PriceList {
  return {
    id: row.id,
    name: row.name,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    isActive: row.is_active,
    pricesIncludeVat: row.prices_include_vat,
    createdAt: row.created_at,
  };
}

/** Every price list of the organization, by name (at most the plan's quota, well under 1,000). */
export async function listPriceLists(orgId: string): Promise<PriceList[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase.from("price_lists").select(COLUMNS).eq("organization_id", orgId).order("name").order("id"),
    "price_lists",
  );
  return rows.map(toPriceList);
}

export async function getPriceList(orgId: string, listId: string): Promise<PriceList | null> {
  const supabase = await createClient();
  const row = must(
    await supabase.from("price_lists").select(COLUMNS).eq("organization_id", orgId).eq("id", listId).maybeSingle(),
    "price_lists",
  );
  return row ? toPriceList(row) : null;
}

// PL-02 -----------------------------------------------------------------------

export type PriceListLine = PriceListLineRule & { createdAt: string };

/** Every line of one price list, by product and quantity (paged: a list may hold more than 1,000 lines). */
export async function listPriceListLines(orgId: string, listId: string): Promise<PriceListLine[]> {
  const supabase = await createClient();
  const { rows } = await readAllPages(async (from, to) =>
    must(
      await supabase
        .from("price_list_lines")
        .select("id, product_id, min_quantity, price_agorot, price_includes_vat, discount_bp, created_at")
        .eq("organization_id", orgId)
        .eq("price_list_id", listId)
        .order("product_id")
        .order("min_quantity")
        .order("id")
        .range(from, to),
      "price_list_lines",
    ),
  );
  return rows.map((row) => ({
    id: row.id,
    productId: row.product_id,
    minQuantity: Number(row.min_quantity),
    priceAgorot: row.price_agorot === null ? null : Number(row.price_agorot),
    discountBp: row.discount_bp,
    priceIncludesVat: row.price_includes_vat,
    createdAt: row.created_at,
  }));
}

export type PricingProduct = {
  id: string;
  name: string;
  priceAgorot: number;
  priceIncludesVat: boolean;
  vatKind: VatKind;
  isActive: boolean;
  archivedAt: string | null;
};

const PRODUCT_COLUMNS = "id, name, price_agorot, price_includes_vat, vat_kind, is_active, archived_at";

type ProductRow = {
  id: string;
  name: string;
  price_agorot: number;
  price_includes_vat: boolean;
  vat_kind: string;
  is_active: boolean;
  archived_at: string | null;
};

function toPricingProduct(row: ProductRow): PricingProduct {
  return {
    id: row.id,
    name: row.name,
    priceAgorot: Number(row.price_agorot),
    priceIncludesVat: row.price_includes_vat,
    // the check constraint holds vat_kind to VAT_KINDS
    vatKind: row.vat_kind as VatKind,
    isActive: row.is_active,
    archivedAt: row.archived_at,
  };
}

/**
 * The products a price list page needs, by name: every product that can get a
 * new line (isOfferable: active and not archived) plus the others its lines
 * use (inactive or archived ones keep their lines). Read in pages.
 */
export async function listPricingProducts(orgId: string, usedIds: string[]): Promise<PricingProduct[]> {
  const supabase = await createClient();
  const { rows: offerable } = await readAllPages(async (from, to) =>
    must(
      await supabase
        .from("products")
        .select(PRODUCT_COLUMNS)
        .eq("organization_id", orgId)
        .eq("is_active", true)
        .is("archived_at", null)
        .order("name")
        .order("id")
        .range(from, to),
      "products",
    ),
  );
  const known = new Set(offerable.map((row) => row.id));
  const missing = [...new Set(usedIds)].filter((id) => !known.has(id));
  const others = await readAllPagesByIds(missing, async (slice, from, to) =>
    must(
      await supabase.from("products").select(PRODUCT_COLUMNS).eq("organization_id", orgId).in("id", slice).order("id").range(from, to),
      "products",
    ),
  );
  return [...offerable, ...others].map(toPricingProduct).sort((a, b) => a.name.localeCompare(b.name, "he"));
}
