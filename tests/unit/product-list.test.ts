import { describe, expect, it } from "vitest";

import { catalogFor, resolveColumns } from "@/features/list-columns/columns";
import type { FilterTree } from "@/features/list-filters/model";
import { filterFields, filterToPostgrest } from "@/features/list-filters/server";
import { productStatusPatch, productUndoPatch } from "@/features/products/bulk-server";
import { PRODUCT_SORT_COLUMNS } from "@/features/products/queries";
import { VIEW_FILTER_KEYS, VIEW_OBJECTS } from "@/features/views/types";

// LST-09 for the product catalog: its columns, its advanced filter, saved views and the bulk changes.

const CATEGORY = "22222222-2222-4222-8222-222222222222";
const UNIT = "44444444-4444-4444-8444-444444444444";
const ctx = { userId: "11111111-1111-4111-8111-111111111111", now: new Date("2026-07-15T07:00:00Z") };
const lookups = { categories: [{ value: CATEGORY, label: "כללי" }], units: [{ value: UNIT, label: "יחידה" }], members: [], tags: [], fields: [] };
const one = (field: string, op: string, value?: string): FilterTree => ({ match: "all", groups: [{ match: "all", conditions: [{ field, op, value }] }] });

describe("the product catalog's columns", () => {
  it("offers the catalog's columns, starts with today's table, and every column sorts", () => {
    const catalog = catalogFor("product", []);
    expect(catalog.map((c) => c.key)).toEqual(["sku", "barcode", "category", "kind", "price", "unit", "vat", "status", "created"]);
    expect(resolveColumns("product", null, catalog).map((c) => c.key)).toEqual(["sku", "category", "kind", "price", "unit", "vat", "status"]);
    for (const column of catalog) expect(Object.keys(PRODUCT_SORT_COLUMNS), column.key).toContain(column.key);
    // a saved choice keeps only columns that exist
    expect(resolveColumns("product", [{ key: "owner", width: "normal" }, { key: "price", width: "wide" }], catalog)).toEqual([{ key: "price", width: "wide" }]);
  });
});

describe("the product catalog's advanced filter", () => {
  const fields = filterFields("product", lookups);

  it("has no owner, tag or custom fields", () => {
    expect(fields.map((f) => f.key)).toEqual(["name", "sku", "barcode", "description", "category", "unit", "kind", "vat", "billing", "price", "active", "created"]);
  });

  it("builds the query from checked values only", () => {
    expect(filterToPostgrest(one("category", "is", CATEGORY), fields, ctx).logic).toBe(`and(and(category_id.eq.${CATEGORY}))`);
    // a category of another business (not in the options) is left out
    expect(filterToPostgrest(one("category", "is", "55555555-5555-4555-8555-555555555555"), fields, ctx)).toEqual({ logic: null, skipped: 1 });
    expect(filterToPostgrest(one("kind", "is", "service"), fields, ctx).logic).toBe('and(and(kind.eq."service"))');
    expect(filterToPostgrest(one("kind", "is", "car"), fields, ctx).logic).toBeNull();
    // the price is typed in shekels and stored in agorot
    expect(filterToPostgrest(one("price", "gt", "12.5"), fields, ctx).logic).toBe("and(and(price_agorot.gt.1250))");
    expect(filterToPostgrest(one("active", "is_false"), fields, ctx).logic).toBe("and(and(or(is_active.is.null,is_active.eq.false)))");
    expect(filterToPostgrest(one("sku", "contains", "AB"), fields, ctx).logic).toBe('and(and(sku.ilike."*AB*"))');
  });
});

describe("saved views of the product catalog", () => {
  it("are a list of their own and keep the catalog's own selects", () => {
    expect(VIEW_OBJECTS).toContain("product");
    expect(VIEW_FILTER_KEYS).toEqual(expect.arrayContaining(["q", "status", "f", "category", "kind"]));
  });
});

describe("bulk changes of products", () => {
  it("active and inactive take a product out of the archive; archiving keeps its active flag", () => {
    expect(productStatusPatch("active")).toEqual({ is_active: true, archived_at: null });
    expect(productStatusPatch("inactive")).toEqual({ is_active: false, archived_at: null });
    const archived = productStatusPatch("archived");
    expect(Object.keys(archived)).toEqual(["archived_at"]);
    expect(archived.archived_at).not.toBeNull();
  });

  it("undo puts back the flag, the archive and the category, and skips a row it cannot read", () => {
    expect(productUndoPatch("status", { id: "x", active: false, archived: false })).toEqual({ is_active: false, archived_at: null });
    const rearchived = productUndoPatch("status", { id: "x", active: true, archived: true });
    expect(rearchived?.is_active).toBe(true);
    expect(rearchived?.archived_at).not.toBeNull();
    expect(productUndoPatch("status", { id: "x" })).toBeNull();
    expect(productUndoPatch("category", { id: "x", category: null })).toEqual({ category_id: null });
    expect(productUndoPatch("category", { id: "x", category: CATEGORY })).toEqual({ category_id: CATEGORY });
    expect(productUndoPatch("category", { id: "x" })).toBeNull();
  });
});
