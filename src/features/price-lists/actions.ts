"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { priceListPath, priceListsPath } from "./paths";
import { isOfferable } from "@/features/products/schema";

import { PRICE_LIST_FIELD_NAMES, PRICE_LIST_LINE_FIELD_NAMES, priceListLineSchema, priceListSchema, type PriceListInput } from "./schema";

// PL-01: owners and admins of a writable organization create, edit and remove price lists;
// RLS refuses everyone else (0 rows / 42501). The plan's capability and quota are checked by the database.

const NAME_TAKEN = "כבר יש מחירון בשם הזה.";

function writeError(error: { code?: string; message?: string }, fallback: string): string {
  if (error.code === "23505") return NAME_TAKEN;
  return dbErrorMessage(error, fallback);
}

function columns(input: PriceListInput) {
  return { name: input.name, valid_from: input.valid_from, valid_to: input.valid_to, is_active: input.is_active };
}

/** A new price list; on success opens it, to add its lines. */
export async function createPriceListAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = priceListSchema.safeParse(pick(formData, PRICE_LIST_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  const { data, error } = await context.supabase
    .from("price_lists")
    .insert({ organization_id: orgId, ...columns(parsed.data) })
    .select("id")
    .single();
  if (error) return fail(writeError(error, "לא הצלחנו ליצור את המחירון. נסו שוב."), { values: formValues(formData) });
  revalidatePath(priceListsPath(orgId));
  redirect(priceListPath(orgId, data.id));
}

export async function updatePriceListAction(orgId: string, listId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, listId);
  if (!context.ok) return context;
  const parsed = priceListSchema.safeParse(pick(formData, PRICE_LIST_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  const { data, error } = await context.supabase
    .from("price_lists")
    .update(columns(parsed.data))
    .eq("organization_id", orgId)
    .eq("id", listId)
    .select("id");
  if (error) return fail(writeError(error, "לא הצלחנו לשמור. נסו שוב."), { values: formValues(formData) });
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  revalidatePath(priceListsPath(orgId));
  revalidatePath(priceListPath(orgId, listId));
  return ok(undefined, "השינויים נשמרו.");
}

/** Removes a price list for good. The products and their own prices are not touched. */
export async function deletePriceListAction(orgId: string, listId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, listId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.from("price_lists").delete().eq("organization_id", orgId).eq("id", listId).select("id");
  if (error) return fail(dbErrorMessage(error));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(priceListsPath(orgId));
  redirect(priceListsPath(orgId));
}

// PL-02 -----------------------------------------------------------------------

/**
 * Saves the price of one product from one quantity in a price list: a new
 * line, or the line that already holds that product and quantity is replaced.
 * Only a product that can be offered (active, not archived) gets a new price;
 * "including VAT" is kept only for a taxable product.
 */
export async function savePriceListLineAction(orgId: string, listId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, listId);
  if (!context.ok) return context;
  const parsed = priceListLineSchema.safeParse(pick(formData, PRICE_LIST_LINE_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  const input = parsed.data;
  const values = formValues(formData);

  const { data: product, error: productError } = await context.supabase
    .from("products")
    .select("id, vat_kind, is_active, archived_at")
    .eq("organization_id", orgId)
    .eq("id", input.product_id)
    .maybeSingle();
  if (productError) return fail(dbErrorMessage(productError), { values });
  if (!product || !isOfferable({ isActive: product.is_active, archivedAt: product.archived_at })) {
    return fail("המוצר שנבחר לא פעיל או בארכיון. רעננו את הדף ובחרו מוצר אחר.", { fieldErrors: { product_id: "יש לבחור מוצר פעיל." }, values });
  }
  const price = {
    price_agorot: input.price_agorot,
    discount_bp: input.discount_bp,
    price_includes_vat: product.vat_kind === "taxable" && input.price_includes_vat,
  };

  const { data: existing, error: findError } = await context.supabase
    .from("price_list_lines")
    .select("id")
    .eq("organization_id", orgId)
    .eq("price_list_id", listId)
    .eq("product_id", input.product_id)
    .eq("min_quantity", input.min_quantity)
    .maybeSingle();
  if (findError) return fail(dbErrorMessage(findError), { values });

  if (existing) {
    const { data, error } = await context.supabase
      .from("price_list_lines")
      .update(price)
      .eq("organization_id", orgId)
      .eq("id", existing.id)
      .select("id");
    if (error) return fail(dbErrorMessage(error, "לא הצלחנו לשמור את המחיר. נסו שוב."), { values });
    if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN, { values });
  } else {
    const { error } = await context.supabase.from("price_list_lines").insert({
      organization_id: orgId,
      price_list_id: listId,
      product_id: input.product_id,
      min_quantity: input.min_quantity,
      ...price,
    });
    if (error) {
      // 23505: someone saved the same product and quantity a moment ago; 23503: the list was removed
      const message =
        error.code === "23505"
          ? "בדיוק נשמר מחיר לאותו מוצר ואותה כמות. רעננו את הדף."
          : error.code === "23503"
            ? "המחירון או המוצר כבר לא קיימים. רעננו את הדף."
            : dbErrorMessage(error, "לא הצלחנו לשמור את המחיר. נסו שוב.");
      return fail(message, { values });
    }
  }
  revalidatePath(priceListPath(orgId, listId));
  return ok(undefined, existing ? "המחיר עודכן." : "המחיר נוסף למחירון.");
}

/** Removes one price (one product from one quantity) from a price list. */
export async function deletePriceListLineAction(orgId: string, listId: string, lineId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, listId, lineId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("price_list_lines")
    .delete()
    .eq("organization_id", orgId)
    .eq("price_list_id", listId)
    .eq("id", lineId)
    .select("id");
  if (error) return fail(dbErrorMessage(error));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(priceListPath(orgId, listId));
  return ok();
}
