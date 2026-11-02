"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { SearchPickerResult } from "@/components/ui/search-picker";
import { quotePath, quoteDocumentPath } from "@/features/quotes/paths";
import { orderDocumentPath, orderPath } from "@/features/orders/paths";
import { quantityField } from "@/features/deal-lines/schema";
import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, optionalTextArg, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { textSearchFilter } from "@/lib/search";

import { BUNDLE_DISPLAYS } from "./bundle";
import { productPath } from "./paths";

// PRD-09: the parts of a bundle (product_bundle_items) and the display choice of a bundle line, written with the user's
// session: RLS and app.product_bundle_items_check decide (catalog rights, the products capability, no nesting, 50 parts).

const partSchema = z.object({
  component_id: z.preprocess((value) => (typeof value === "string" ? value : ""), z.uuid({ error: "יש לבחור מוצר." })),
  quantity: quantityField,
});

const PART_TAKEN = "המוצר הזה כבר נמצא בחבילה. אפשר לשנות את הכמות שלו.";

function partError(error: { code?: string; message?: string; hint?: string }, fallback: string): string {
  if (error.code === "23505") return PART_TAKEN;
  if (error.code === "23514" && !error.hint) return "כמות גדולה מאפס, עד שלוש ספרות אחרי הנקודה.";
  return dbErrorMessage(error, fallback);
}

/** Offerable products that may be a part: active, not archived, not a bundle, not this bundle (at most 20). */
export async function searchBundlePartsAction(orgId: string, bundleId: string, query: unknown): Promise<SearchPickerResult> {
  if (!validArg(optionalTextArg(100), query)) return { error: INVALID_ARGS };
  const context = await actionContext(orgId, bundleId);
  if (!context.ok) return { error: context.message };
  const filter = textSearchFilter(String(query ?? ""));
  if (!filter) return { hits: [] };
  const { data, error } = await context.supabase
    .from("products")
    .select("id, name, sku")
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .is("archived_at", null)
    .neq("kind", "bundle")
    .neq("id", bundleId)
    .or(filter)
    .order("name")
    .order("id")
    .limit(20);
  if (error) return { error: dbErrorMessage(error) };
  return { hits: data.map((row) => ({ id: row.id, label: row.name, detail: row.sku })) };
}

export async function addBundlePartAction(orgId: string, bundleId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, bundleId);
  if (!context.ok) return context;
  const parsed = partSchema.safeParse({ component_id: formData.get("component_id"), quantity: formData.get("quantity") });
  if (!parsed.success) return invalid(parsed.error, formData);
  // a new part goes last
  const { data: last, error: readError } = await context.supabase
    .from("product_bundle_items")
    .select("position")
    .eq("organization_id", orgId)
    .eq("bundle_id", bundleId)
    .order("position", { ascending: false })
    .limit(1);
  if (readError) return fail(dbErrorMessage(readError), { values: formValues(formData) });
  const { error } = await context.supabase.from("product_bundle_items").insert({
    organization_id: orgId,
    bundle_id: bundleId,
    component_id: parsed.data.component_id,
    quantity: parsed.data.quantity,
    position: Math.min((last[0]?.position ?? -1) + 1, 100000),
  });
  if (error) return fail(partError(error, "לא הצלחנו להוסיף את הרכיב. נסו שוב."), { values: formValues(formData) });
  revalidatePath(productPath(orgId, bundleId));
  return ok();
}

export async function setBundlePartQuantityAction(orgId: string, bundleId: string, partId: string, quantity: unknown): Promise<ActionResult> {
  const parsed = quantityField.safeParse(quantity);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? INVALID_ARGS);
  const context = await actionContext(orgId, bundleId, partId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("product_bundle_items")
    .update({ quantity: parsed.data })
    .eq("organization_id", orgId)
    .eq("bundle_id", bundleId)
    .eq("id", partId)
    .select("id");
  if (error) return fail(partError(error, "לא הצלחנו לשמור. נסו שוב."));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(productPath(orgId, bundleId));
  return ok();
}

export async function removeBundlePartAction(orgId: string, bundleId: string, partId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, bundleId, partId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("product_bundle_items")
    .delete()
    .eq("organization_id", orgId)
    .eq("bundle_id", bundleId)
    .eq("id", partId)
    .select("id");
  if (error) return fail(dbErrorMessage(error));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(productPath(orgId, bundleId));
  return ok();
}

const lineKindArg = z.enum(["deal", "quote", "order"]);
const displayArg = z.enum(BUNDLE_DISPLAYS);

/**
 * The display of a bundle line on a deal, a draft quote or a draft order: one line, or itemised (its parts under it).
 * RLS lets only someone who may edit the line write it (a quote or an order only while it is a draft).
 */
export async function setLineBundleDisplayAction(orgId: string, kind: unknown, parentId: string, lineId: string, display: unknown): Promise<ActionResult> {
  if (!validArg(lineKindArg, kind) || !validArg(displayArg, display)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, parentId, lineId);
  if (!context.ok) return context;
  // one statement per table, so each keeps its own column types
  const patch = { bundle_display: display };
  const { data, error } =
    kind === "deal"
      ? await context.supabase.from("deal_lines").update(patch).eq("organization_id", orgId).eq("deal_id", parentId).eq("id", lineId).select("id")
      : kind === "quote"
        ? await context.supabase.from("quote_lines").update(patch).eq("organization_id", orgId).eq("quote_id", parentId).eq("id", lineId).select("id")
        : await context.supabase.from("order_lines").update(patch).eq("organization_id", orgId).eq("order_id", parentId).eq("id", lineId).select("id");
  if (error) return fail(dbErrorMessage(error));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  if (kind === "deal") revalidatePath(paths.deal(orgId, parentId));
  if (kind === "quote") {
    revalidatePath(quotePath(orgId, parentId));
    revalidatePath(quoteDocumentPath(orgId, parentId));
  }
  if (kind === "order") {
    revalidatePath(orderPath(orgId, parentId));
    revalidatePath(orderDocumentPath(orgId, parentId));
  }
  return ok();
}
