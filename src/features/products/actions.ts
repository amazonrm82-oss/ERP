"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, booleanArg, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { productPath, productsPath } from "./paths";
import { copyName, PRODUCT_FIELD_NAMES, productSchema, type ProductInput } from "./schema";

// PRD-02: owners and admins of a writable organization create, edit, copy, archive and remove
// products; RLS refuses everyone else (0 rows / 42501).

const SKU_TAKEN = 'המק"ט הזה כבר שייך למוצר אחר.';
const IN_USE = "המוצר מופיע במסמכים, ולכן אי אפשר למחוק אותו. אפשר להעביר אותו לארכיון: הוא לא יוצע במסמכים חדשים, והמסמכים הקיימים לא ישתנו.";
// PL-02: a price list line references the product with no on delete action (price_list_lines_product_fk)
const IN_PRICE_LIST = "המוצר מופיע במחירון, ולכן אי אפשר למחוק אותו. אפשר להסיר אותו מהמחירונים, או להעביר אותו לארכיון: הוא לא יוצע במסמכים חדשים, והמחירים שלו יישמרו.";
// DLI-01: a deal line references the product with no on delete action (deal_lines_product_fk)
const IN_DEAL = "המוצר מופיע בשורות של עסקאות, ולכן אי אפשר למחוק אותו. אפשר להעביר אותו לארכיון: הוא לא יוצע בשורות חדשות, והשורות הקיימות לא ישתנו.";

function revalidateProducts(orgId: string, productId?: string) {
  revalidatePath(productsPath(orgId));
  if (productId) revalidatePath(productPath(orgId, productId));
}

function writeError(error: { code?: string; message?: string }, fallback: string): string {
  if (error.code === "23505") return SKU_TAKEN;
  if (error.code === "23503") return "הקטגוריה או היחידה שנבחרו כבר לא קיימות. רעננו את הדף ונסו שוב.";
  return dbErrorMessage(error, fallback);
}

function columns(input: ProductInput) {
  return {
    name: input.name,
    description: input.description,
    sku: input.sku,
    barcode: input.barcode,
    category_id: input.category_id,
    unit_id: input.unit_id,
    kind: input.kind,
    vat_kind: input.vat_kind,
    billing: input.billing,
    price_agorot: input.price_agorot,
    price_includes_vat: input.price_includes_vat,
    duration_minutes: input.duration_minutes,
    is_active: input.is_active,
  };
}

/** A new product; on success opens its page. */
export async function createProductAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = productSchema.safeParse(pick(formData, PRODUCT_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  const { data, error } = await context.supabase
    .from("products")
    .insert({ organization_id: orgId, ...columns(parsed.data) })
    .select("id")
    .single();
  if (error) return fail(writeError(error, "לא הצלחנו ליצור את המוצר. נסו שוב."), { values: formValues(formData) });
  revalidateProducts(orgId);
  redirect(productPath(orgId, data.id));
}

export async function updateProductAction(orgId: string, productId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, productId);
  if (!context.ok) return context;
  const parsed = productSchema.safeParse(pick(formData, PRODUCT_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  const { data, error } = await context.supabase
    .from("products")
    .update(columns(parsed.data))
    .eq("organization_id", orgId)
    .eq("id", productId)
    .select("id");
  if (error) return fail(writeError(error, "לא הצלחנו לשמור. נסו שוב."), { values: formValues(formData) });
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  revalidateProducts(orgId, productId);
  return ok(undefined, "השינויים נשמרו.");
}

/**
 * A copy of a product (PRD-02): "עותק של …", active and not archived, without
 * the SKU and the barcode (they identify the original). Opens the copy.
 */
export async function duplicateProductAction(orgId: string, productId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, productId);
  if (!context.ok) return context;
  const { data: source, error: readError } = await context.supabase
    .from("products")
    .select("name, description, category_id, unit_id, kind, vat_kind, billing, price_agorot, price_includes_vat, currency, duration_minutes")
    .eq("organization_id", orgId)
    .eq("id", productId)
    .maybeSingle();
  if (readError) return fail(dbErrorMessage(readError));
  if (!source) return fail(NOT_FOUND_OR_FORBIDDEN);
  const { data, error } = await context.supabase
    .from("products")
    .insert({ organization_id: orgId, ...source, name: copyName(source.name), sku: null, barcode: null, is_active: true })
    .select("id")
    .single();
  if (error) return fail(writeError(error, "לא הצלחנו ליצור עותק. נסו שוב."));
  revalidateProducts(orgId);
  redirect(productPath(orgId, data.id));
}

/** Archive (hidden by default, never offered for new documents) or restore. */
export async function setProductArchivedAction(orgId: string, productId: string, archived: boolean): Promise<ActionResult> {
  if (!validArg(booleanArg, archived)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, productId);
  if (!context.ok) return context;
  // the server stamps the time (trigger products_archive_stamp)
  const { data, error } = await context.supabase
    .from("products")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("organization_id", orgId)
    .eq("id", productId)
    .select("id");
  if (error) return fail(dbErrorMessage(error));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidateProducts(orgId, productId);
  return ok();
}

/**
 * Removes a product for good, only while nothing refers to it. Once document
 * lines exist, a product on a line cannot be removed (foreign key, 23503) and
 * the person is told to archive it instead.
 */
export async function deleteProductAction(orgId: string, productId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, productId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.from("products").delete().eq("organization_id", orgId).eq("id", productId).select("id");
  if (error) {
    if (error.code !== "23503") return fail(dbErrorMessage(error));
    if (error.message.includes("price_list_lines_product_fk")) return fail(IN_PRICE_LIST);
    return fail(error.message.includes("deal_lines_product_fk") ? IN_DEAL : IN_USE);
  }
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidateProducts(orgId);
  redirect(productsPath(orgId));
}
