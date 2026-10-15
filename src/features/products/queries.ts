import "server-only";

import { getUserNames } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { PAGE_SIZE, textSearchFilter } from "@/lib/search";
import { sortColumn, type Sort } from "@/lib/sort";
import { createClient } from "@/lib/supabase/server";

import { PRICE_FIELDS, priceHistory, type PriceChange } from "./price-history";
import type { Billing, ProductKind, VatKind } from "./schema";

export type Product = {
  id: string;
  name: string;
  description: string | null;
  sku: string | null;
  barcode: string | null;
  categoryId: string | null;
  unitId: string | null;
  kind: ProductKind;
  vatKind: VatKind;
  billing: Billing;
  priceAgorot: number;
  priceIncludesVat: boolean;
  currency: string;
  durationMinutes: number | null;
  isActive: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const COLUMNS =
  "id, name, description, sku, barcode, category_id, unit_id, kind, vat_kind, billing, price_agorot, price_includes_vat, currency, duration_minutes, is_active, archived_at, created_at, updated_at";

type Row = {
  id: string;
  name: string;
  description: string | null;
  sku: string | null;
  barcode: string | null;
  category_id: string | null;
  unit_id: string | null;
  kind: string;
  vat_kind: string;
  billing: string;
  price_agorot: number;
  price_includes_vat: boolean;
  currency: string;
  duration_minutes: number | null;
  is_active: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

function toProduct(row: Row): Product {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sku: row.sku,
    barcode: row.barcode,
    categoryId: row.category_id,
    unitId: row.unit_id,
    // the database's check constraints hold these to the lists in schema.ts
    kind: row.kind as ProductKind,
    vatKind: row.vat_kind as VatKind,
    billing: row.billing as Billing,
    priceAgorot: Number(row.price_agorot),
    priceIncludesVat: row.price_includes_vat,
    currency: row.currency,
    durationMinutes: row.duration_minutes,
    isActive: row.is_active,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// columns the product list can be sorted by (sort_category, sort_unit: migration products)
export const PRODUCT_SORT_COLUMNS = {
  name: "name",
  sku: "sku",
  category: "sort_category",
  kind: "kind",
  price: "price_agorot",
  unit: "sort_unit",
  vat: "vat_kind",
  status: "is_active",
  created: "created_at",
} as const;
export type ProductSortKey = keyof typeof PRODUCT_SORT_COLUMNS;
export const PRODUCT_DEFAULT_SORT: Sort<ProductSortKey> = { key: "name", ascending: true };

// "" = everything not archived (the default); archived products show only when asked for
export const PRODUCT_STATUS_FILTERS = ["active", "inactive", "archived"] as const;
export type ProductStatusFilter = (typeof PRODUCT_STATUS_FILTERS)[number] | "";

export type ProductListOptions = {
  search: string;
  // a category and its subcategories (categoryWithChildren)
  categoryIds?: string[] | null;
  kind?: ProductKind | null;
  status: ProductStatusFilter;
  page: number;
  sort?: Sort<ProductSortKey>;
  // PRD-05: an export reads the list in larger chunks instead of a page
  chunk?: { from: number; size: number };
};

/** One page of the catalog (PRD-01). Fetches one extra row to know if there is a next page. */
export async function listProducts(orgId: string, options: ProductListOptions): Promise<{ products: Product[]; hasMore: boolean }> {
  const supabase = await createClient();
  const size = options.chunk?.size ?? PAGE_SIZE;
  const from = options.chunk?.from ?? (options.page - 1) * PAGE_SIZE;
  let query = supabase.from("products").select(COLUMNS).eq("organization_id", orgId);
  const search = textSearchFilter(options.search);
  if (search) query = query.or(search);
  if (options.categoryIds && options.categoryIds.length > 0) query = query.in("category_id", options.categoryIds);
  if (options.kind) query = query.eq("kind", options.kind);
  if (options.status === "archived") {
    query = query.not("archived_at", "is", null);
  } else {
    query = query.is("archived_at", null);
    if (options.status === "active") query = query.eq("is_active", true);
    if (options.status === "inactive") query = query.eq("is_active", false);
  }
  const sort = options.sort ?? PRODUCT_DEFAULT_SORT;
  const rows =
    must(
      await query
        .order(sortColumn(PRODUCT_SORT_COLUMNS, sort.key), { ascending: sort.ascending, nullsFirst: false })
        .order("id", { ascending: sort.ascending })
        .range(from, from + size),
      "products",
    ) ?? [];
  return { products: rows.slice(0, size).map(toProduct), hasMore: rows.length > size };
}

/** One product of the organization, archived ones included, or null. */
export async function getProduct(orgId: string, productId: string): Promise<Product | null> {
  const supabase = await createClient();
  const row = must(await supabase.from("products").select(COLUMNS).eq("organization_id", orgId).eq("id", productId).maybeSingle(), "product");
  return row ? toProduct(row) : null;
}

/**
 * PRD-07: the price changes of one product, newest first (at most 50), from the audit log.
 * Read with the user's session: audit_log RLS lets owners and admins read it, so anyone else
 * gets an empty list (the page shows the section to owners and admins only).
 */
export async function listProductPriceHistory(orgId: string, product: Product): Promise<PriceChange[]> {
  const supabase = await createClient();
  const rows =
    must(
      await supabase
        .from("audit_log")
        .select("id, created_at, actor_id, changes")
        .eq("organization_id", orgId)
        .eq("entity_type", "products")
        .eq("entity_id", product.id)
        .eq("action", "update")
        .or(PRICE_FIELDS.map((field) => `changes->${field}.not.is.null`).join(","))
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(50),
      "audit_log",
    ) ?? [];
  const names = await getUserNames(rows.map((r) => r.actor_id));
  return priceHistory(
    product,
    rows.map((r) => ({ id: r.id, createdAt: r.created_at, actorName: r.actor_id ? (names.get(r.actor_id) ?? "משתמש") : null, changes: r.changes })),
  );
}
