import "server-only";

import { revalidatePath } from "next/cache";

import type { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { isUuid } from "@/lib/paths";

import { productsPath } from "./paths";

// LST-07 / LST-09 for the product catalog: bulk actions on the picked products. Each product is changed on its
// own with the user's session, so the products policies decide row by row (catalog editors, PRM-01 included):
// a product the user may not change is skipped and counted, and the rest still go through.

type Supabase = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>["supabase"];

// the state a product can be put in from the list; "archived" keeps is_active as it was (PRD-02)
export const PRODUCT_BULK_STATUSES = ["active", "inactive", "archived"] as const;
export type ProductBulkStatus = (typeof PRODUCT_BULK_STATUSES)[number];

export type ProductBulkChange = { kind: "status"; statusId: string } | { kind: "category"; categoryId: string | null };
// what each changed product was before, so the change can be undone (FXU-06)
export type ProductUndoRow = { id: string; active?: boolean; archived?: boolean; category?: string | null };
export type ProductBulkOutcome = { done: number; skipped: number; undo: { kind: "status" | "category"; rows: ProductUndoRow[] } };

type Patch = { is_active?: boolean; archived_at?: string | null; category_id?: string | null };

/** The update a status choice makes: active and inactive take a product out of the archive; archiving stamps it (products_archive_stamp). */
export function productStatusPatch(status: ProductBulkStatus): Patch {
  if (status === "archived") return { archived_at: new Date().toISOString() };
  return { is_active: status === "active", archived_at: null };
}

/** The update that puts a product back as it was before a bulk change. */
export function productUndoPatch(kind: "status" | "category", row: ProductUndoRow): Patch | null {
  if (kind === "category") return row.category === undefined ? null : { category_id: row.category };
  if (row.active === undefined || row.archived === undefined) return null;
  // an archive undone keeps the old is_active; an un-archive undone archives again (stamped now)
  return { is_active: row.active, archived_at: row.archived ? new Date().toISOString() : null };
}

// rows changed at the same time
const PARALLEL = 8;

async function eachLimited<T>(items: T[], run: (item: T) => Promise<boolean>): Promise<T[]> {
  const done: T[] = [];
  for (let i = 0; i < items.length; i += PARALLEL) {
    const slice = items.slice(i, i + PARALLEL);
    const results = await Promise.all(slice.map(run));
    slice.forEach((item, k) => results[k] && done.push(item));
  }
  return done;
}

async function update(supabase: Supabase, orgId: string, id: string, patch: Patch): Promise<boolean> {
  const { data, error } = await supabase.from("products").update(patch).eq("organization_id", orgId).eq("id", id).select("id");
  return !error && data.length > 0;
}

/** A bulk change of the picked products (ids already checked by the caller). */
export async function productBulkAction(supabase: Supabase, orgId: string, ids: string[], change: ProductBulkChange): Promise<ActionResult<ProductBulkOutcome>> {
  let patch: Patch;
  if (change.kind === "status") {
    const status = PRODUCT_BULK_STATUSES.find((s) => s === change.statusId);
    if (!status) return fail("יש לבחור מצב.");
    patch = productStatusPatch(status);
  } else {
    if (change.categoryId !== null && !isUuid(change.categoryId)) return fail("יש לבחור קטגוריה.");
    if (change.categoryId !== null) {
      const { data: category, error } = await supabase.from("product_categories").select("id").eq("organization_id", orgId).eq("id", change.categoryId).maybeSingle();
      if (error) return fail(dbErrorMessage(error));
      if (!category) return fail("הקטגוריה כבר לא קיימת. רעננו את הדף ונסו שוב.");
    }
    patch = { category_id: change.categoryId };
  }

  // the picked products the user can see, as they are now; the rest are counted as skipped
  const { data, error } = await supabase.from("products").select("id, is_active, archived_at, category_id").eq("organization_id", orgId).in("id", ids);
  if (error) return fail(dbErrorMessage(error));
  const changed = await eachLimited(data, (row) => update(supabase, orgId, row.id, patch));
  const rows: ProductUndoRow[] = changed.map((row) =>
    change.kind === "status" ? { id: row.id, active: row.is_active, archived: row.archived_at !== null } : { id: row.id, category: row.category_id },
  );
  revalidatePath(productsPath(orgId));
  return ok({ done: changed.length, skipped: ids.length - changed.length, undo: { kind: change.kind, rows } });
}

/** Puts back what a bulk change of products changed, row by row with the user's session. */
export async function productUndoAction(supabase: Supabase, orgId: string, kind: "status" | "category", rows: ProductUndoRow[]): Promise<ActionResult<{ done: number }>> {
  const undone = await eachLimited(rows, async (row) => {
    const patch = productUndoPatch(kind, row);
    return patch ? update(supabase, orgId, row.id, patch) : false;
  });
  revalidatePath(productsPath(orgId));
  return ok({ done: undone.length });
}
