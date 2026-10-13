import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { dbErrorMessage } from "@/lib/errors";

import { CUSTOM_PREFIX } from "./fields";
import { findCategory, nameKey, parseProductRow, skuKey, type CategoryRef, type ProductRowValues } from "./product-rows";
import type { RowOutcome } from "./server";

// PRD-05: importing products. Writes with the user's session (RLS: owners and admins of a
// writable organization). Each product is tagged with the import, so undoing it removes exactly
// the products it created. The plan quota (products_quota, PRD-08) is checked by the database
// for every row: the import keeps the rows that fit and stops at the first one that does not.

type Client = SupabaseClient<Database>;

export type ProductImportContext = { supabase: Client; orgId: string; mapping: string[] };

export type ProductLookups = { categories: CategoryRef[]; units: Map<string, string>; pricesIncludeVat: boolean };

export const PRODUCT_SKU_TAKEN = 'כבר קיים מוצר עם המק"ט הזה.';
export const PRODUCT_SKU_REPEATED = 'המק"ט כבר הופיע בשורה קודמת בקובץ.';
export const UNIT_UNKNOWN = (unit: string) => `אין יחידת מידה בשם "${unit}". אפשר להוסיף אותה בהגדרות, בעמוד "קטגוריות ויחידות מידה", ולייבא שוב.`;
export const CATEGORY_PATH_UNKNOWN = (category: string) => `אין קטגוריה "${category}". תת-קטגוריה נכתבת "ראשית > משנה", ושתיהן צריכות להיות קיימות.`;
export const CATEGORY_AMBIGUOUS = (category: string) => `יש כמה תתי-קטגוריות בשם "${category}". כתבו "ראשית > ${category}".`;
export const CATEGORY_NEW = (category: string) => `תיווצר קטגוריה ראשית חדשה: "${category}".`;
export const CATEGORY_CREATED = (category: string) => `נוצרה קטגוריה ראשית חדשה: "${category}".`;
const CATEGORY_NAME_MAX = 80;
const LOOKUPS_FAILED = "לא הצלחנו לקרוא את הקטגוריות ויחידות המידה. נסו שוב.";

/** A read the import cannot go on without failed: the chunk stops (FXC-02). */
export class ProductImportStopped extends Error {}

export async function loadProductLookups(ctx: ProductImportContext): Promise<ProductLookups> {
  const { supabase, orgId } = ctx;
  const [categories, units, settings] = await Promise.all([
    supabase.from("product_categories").select("id, parent_id, name").eq("organization_id", orgId),
    supabase.from("product_units").select("id, name").eq("organization_id", orgId),
    supabase.from("org_document_settings").select("prices_include_vat").eq("organization_id", orgId).maybeSingle(),
  ]);
  if (categories.error || units.error || settings.error) throw new ProductImportStopped(LOOKUPS_FAILED);
  return {
    categories: categories.data.map((c) => ({ id: c.id, parentId: c.parent_id, name: c.name })),
    units: new Map(units.data.map((u) => [nameKey(u.name), u.id])),
    pricesIncludeVat: settings.data?.prices_include_vat === true,
  };
}

type Prepared = {
  row: number;
  values: ProductRowValues & { unit_id: string | null; category_id: string | null };
  // a top category the row names that does not exist yet
  newCategory: string | null;
};

function rawCells(mapping: string[], cells: string[]): Record<string, string> {
  const raw: Record<string, string> = {};
  mapping.forEach((target, index) => {
    if (!target || target.startsWith(CUSTOM_PREFIX)) return;
    const value = String(cells[index] ?? "").trim();
    if (value !== "") raw[target] = value;
  });
  return raw;
}

function prepare(ctx: ProductImportContext, look: ProductLookups, cells: string[], row: number): Prepared | string {
  const parsed = parseProductRow(rawCells(ctx.mapping, cells), look.pricesIncludeVat);
  if (typeof parsed === "string") return parsed;
  let unitId: string | null = null;
  if (parsed.unit) {
    unitId = look.units.get(nameKey(parsed.unit)) ?? null;
    if (!unitId) return UNIT_UNKNOWN(parsed.unit);
  }
  let categoryId: string | null = null;
  let newCategory: string | null = null;
  if (parsed.category) {
    const found = findCategory(look.categories, parsed.category);
    if (found === "missing-path") return CATEGORY_PATH_UNKNOWN(parsed.category);
    if (found === "ambiguous") return CATEGORY_AMBIGUOUS(parsed.category);
    if (found === "missing") {
      newCategory = parsed.category.trim().replace(/\s+/g, " ");
      if (Array.from(newCategory).length > CATEGORY_NAME_MAX) return `שם הקטגוריה ארוך מדי (עד ${CATEGORY_NAME_MAX} תווים).`;
    } else {
      categoryId = found.id;
    }
  }
  return { row, values: { ...parsed.values, unit_id: unitId, category_id: categoryId }, newCategory };
}

/** The SKUs of the chunk that the catalog already holds (keys without case). */
async function takenSkus(ctx: ProductImportContext, rows: Prepared[]): Promise<Set<string>> {
  const skus = [...new Set(rows.map((r) => r.values.sku).filter((s): s is string => Boolean(s)))];
  if (skus.length === 0) return new Set();
  const { data, error } = await ctx.supabase.rpc("product_sku_matches", { p_org: ctx.orgId, p_skus: skus });
  if (error) throw new ProductImportStopped(dbErrorMessage(error, 'בדיקת המק"טים הכפולים נכשלה. נסו שוב.'));
  return new Set(data.map((p) => skuKey(p.sku)));
}

/** Creates the missing top categories of the chunk; returns their ids by name key, and a message per name that failed. */
async function createCategories(ctx: ProductImportContext, look: ProductLookups, names: string[]): Promise<{ ids: Map<string, string>; failed: Map<string, string> }> {
  const ids = new Map<string, string>();
  const failed = new Map<string, string>();
  for (const name of names) {
    const { data, error } = await ctx.supabase.from("product_categories").insert({ organization_id: ctx.orgId, name }).select("id, name").single();
    if (!error) {
      ids.set(nameKey(name), data.id);
      look.categories.push({ id: data.id, parentId: null, name: data.name });
      continue;
    }
    if (error.code === "23505") {
      // made meanwhile (another import or a person): use it
      const { data: existing, error: readError } = await ctx.supabase.from("product_categories").select("id, name").eq("organization_id", ctx.orgId).is("parent_id", null);
      const match = readError ? undefined : existing.find((c) => nameKey(c.name) === nameKey(name));
      if (match) {
        ids.set(nameKey(name), match.id);
        continue;
      }
    }
    failed.set(nameKey(name), dbErrorMessage(error, "לא הצלחנו ליצור את הקטגוריה."));
  }
  return { ids, failed };
}

/**
 * Validates and writes one chunk. With jobId null it is a dry run (the preview): nothing is
 * written. `stopped` says why the import cannot go on (the plan quota or capability); the rows
 * of the chunk that were not written then carry that message.
 */
export async function processProductChunk(
  ctx: ProductImportContext,
  lookups: ProductLookups | null,
  chunk: string[][],
  firstRow: number,
  jobId: string | null,
): Promise<{ outcomes: RowOutcome[]; stopped: string | null }> {
  const look = lookups ?? (await loadProductLookups(ctx));
  const outcomes: RowOutcome[] = [];
  const prepared: Prepared[] = [];
  chunk.forEach((cells, i) => {
    const result = prepare(ctx, look, cells, firstRow + i);
    if (typeof result === "string") outcomes.push({ row: firstRow + i, status: "failed", message: result });
    else prepared.push(result);
  });

  // duplicates by SKU: in the catalog, or earlier in this chunk (earlier chunks are in the catalog by now)
  const taken = await takenSkus(ctx, prepared);
  const seen = new Set<string>();
  const toWrite: Prepared[] = [];
  for (const row of prepared) {
    const key = row.values.sku ? skuKey(row.values.sku) : null;
    if (key && taken.has(key)) outcomes.push({ row: row.row, status: "skipped", message: PRODUCT_SKU_TAKEN });
    else if (key && seen.has(key)) outcomes.push({ row: row.row, status: "skipped", message: PRODUCT_SKU_REPEATED });
    else toWrite.push(row);
    if (key) seen.add(key);
  }

  const newNames = [...new Map(toWrite.filter((r) => r.newCategory).map((r) => [nameKey(r.newCategory!), r.newCategory!])).values()];
  if (!jobId) {
    const announced = new Set<string>();
    for (const row of toWrite) {
      const k = row.newCategory ? nameKey(row.newCategory) : null;
      const warning = k && !announced.has(k) ? CATEGORY_NEW(row.newCategory!) : undefined;
      if (k) announced.add(k);
      outcomes.push(warning ? { row: row.row, status: "ok", warning } : { row: row.row, status: "ok" });
    }
    return { outcomes: outcomes.sort((a, b) => a.row - b.row), stopped: null };
  }

  const { ids: created, failed: categoryFailed } = await createCategories(ctx, look, newNames);
  const ready: Array<Prepared & { warning?: string }> = [];
  const announced = new Set<string>();
  for (const row of toWrite) {
    const k = row.newCategory ? nameKey(row.newCategory) : null;
    if (k && categoryFailed.has(k)) {
      outcomes.push({ row: row.row, status: "failed", message: categoryFailed.get(k) });
      continue;
    }
    if (k) row.values.category_id = created.get(k) ?? null;
    const warning = k && !announced.has(k) ? CATEGORY_CREATED(row.newCategory!) : undefined;
    if (k) announced.add(k);
    ready.push(warning ? { ...row, warning } : row);
  }

  const insertRow = (row: Prepared) => ({ organization_id: ctx.orgId, import_job_id: jobId, ...row.values });
  const done = (row: Prepared & { warning?: string }): RowOutcome => (row.warning ? { row: row.row, status: "created", warning: row.warning } : { row: row.row, status: "created" });

  let stopped: string | null = null;
  if (ready.length) {
    const { error } = await ctx.supabase.from("products").insert(ready.map(insertRow));
    if (!error) {
      for (const row of ready) outcomes.push(done(row));
    } else {
      // one row at a time: the rows that fit the quota go in, a taken SKU is skipped, a bad row fails alone
      for (const row of ready) {
        if (stopped) {
          outcomes.push({ row: row.row, status: "failed", message: stopped });
          continue;
        }
        const { error: rowError } = await ctx.supabase.from("products").insert(insertRow(row));
        if (!rowError) outcomes.push(done(row));
        else if (rowError.code === "23505") outcomes.push({ row: row.row, status: "skipped", message: PRODUCT_SKU_TAKEN });
        else if (rowError.code === "P0001" && /^(limit|feature):/.test(rowError.hint ?? "")) {
          stopped = dbErrorMessage(rowError, "הגעתם למגבלת החבילה.");
          outcomes.push({ row: row.row, status: "failed", message: stopped });
        } else outcomes.push({ row: row.row, status: "failed", message: dbErrorMessage(rowError, "השמירה נכשלה.") });
      }
    }
  }
  return { outcomes: outcomes.sort((a, b) => a.row - b.row), stopped };
}
