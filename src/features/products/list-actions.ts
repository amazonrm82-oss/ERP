"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, directionArg, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { categorySchema, unitSchema } from "./lists";
import { productListsSettingsPath, productsPath } from "./paths";

// PRD-04: owners and admins manage product categories and units; RLS refuses everyone else (0 rows / 42501).

type Context = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>;

function revalidateLists(orgId: string) {
  revalidatePath(productListsSettingsPath(orgId));
  // the filters and pickers of the catalog
  revalidatePath(productsPath(orgId), "layout");
}

const CATEGORY_TAKEN = "כבר יש קטגוריה בשם הזה באותה רמה.";
const UNIT_TAKEN = "יחידת המידה הזו כבר ברשימה.";
const UNIT_IN_USE = "יש מוצרים עם יחידת המידה הזו, ולכן אי אפשר למחוק אותה. אפשר לשנות לה את השם, או להחליף אותה במוצרים ואז למחוק.";

async function siblingsOf(context: Context, orgId: string, parentId: string | null) {
  let query = context.supabase.from("product_categories").select("id, position").eq("organization_id", orgId);
  query = parentId ? query.eq("parent_id", parentId) : query.is("parent_id", null);
  const { data, error } = await query.order("position", { ascending: true }).order("name", { ascending: true });
  return { data: data ?? [], error };
}

async function unitsOf(context: Context, orgId: string) {
  const { data, error } = await context.supabase
    .from("product_units")
    .select("id, position")
    .eq("organization_id", orgId)
    .order("position", { ascending: true })
    .order("name", { ascending: true });
  return { data: data ?? [], error };
}

/** Swaps an item with its neighbour and writes the positions that changed. */
async function reorder(
  context: Context,
  orgId: string,
  table: "product_categories" | "product_units",
  ordered: Array<{ id: string; position: number }>,
  id: string,
  direction: "up" | "down",
): Promise<ActionResult> {
  const index = ordered.findIndex((item) => item.id === id);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= ordered.length) {
    return ok();
  }
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  for (const [position, item] of ordered.entries()) {
    if (item.position !== position) {
      const { data, error } = await context.supabase
        .from(table)
        .update({ position })
        .eq("organization_id", orgId)
        .eq("id", item.id)
        .select("id");
      if (error) return fail(dbErrorMessage(error));
      if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
    }
  }
  return ok();
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export async function addCategoryAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = categorySchema.safeParse(pick(formData, ["name", "parent_id"]));
  if (!parsed.success) return invalid(parsed.error, formData);
  const siblings = await siblingsOf(context, orgId, parsed.data.parent_id);
  if (siblings.error) return fail(dbErrorMessage(siblings.error), { values: formValues(formData) });
  const { error } = await context.supabase.from("product_categories").insert({
    organization_id: orgId,
    name: parsed.data.name,
    parent_id: parsed.data.parent_id,
    position: siblings.data.length,
  });
  if (error) {
    return fail(error.code === "23505" ? CATEGORY_TAKEN : dbErrorMessage(error, "לא הצלחנו להוסיף את הקטגוריה. נסו שוב."), { values: formValues(formData) });
  }
  revalidateLists(orgId);
  return ok();
}

/** Renames a category and, for one without subcategories, moves it under another top category or to the top. */
export async function updateCategoryAction(orgId: string, categoryId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, categoryId);
  if (!context.ok) return context;
  const parsed = categorySchema.safeParse(pick(formData, ["name", "parent_id"]));
  if (!parsed.success) return invalid(parsed.error, formData);
  // a form without the parent picker (a category with subcategories) keeps its place
  const changes: { name: string; parent_id?: string | null; position?: number } = { name: parsed.data.name };
  if (formData.has("parent_id")) {
    const { data: current, error: readError } = await context.supabase
      .from("product_categories")
      .select("parent_id")
      .eq("organization_id", orgId)
      .eq("id", categoryId)
      .maybeSingle();
    if (readError) return fail(dbErrorMessage(readError), { values: formValues(formData) });
    if (!current) return fail(NOT_FOUND_OR_FORBIDDEN);
    if (current.parent_id !== parsed.data.parent_id) {
      const siblings = await siblingsOf(context, orgId, parsed.data.parent_id);
      if (siblings.error) return fail(dbErrorMessage(siblings.error), { values: formValues(formData) });
      changes.parent_id = parsed.data.parent_id;
      changes.position = siblings.data.length;
    }
  }
  const { data, error } = await context.supabase
    .from("product_categories")
    .update(changes)
    .eq("organization_id", orgId)
    .eq("id", categoryId)
    .select("id");
  if (error) {
    return fail(error.code === "23505" ? CATEGORY_TAKEN : dbErrorMessage(error, "לא הצלחנו לשמור. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidateLists(orgId);
  return ok();
}

export async function moveCategoryAction(orgId: string, categoryId: string, direction: "up" | "down"): Promise<ActionResult> {
  if (!validArg(directionArg, direction)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, categoryId);
  if (!context.ok) return context;
  const { data: current, error: readError } = await context.supabase
    .from("product_categories")
    .select("parent_id")
    .eq("organization_id", orgId)
    .eq("id", categoryId)
    .maybeSingle();
  if (readError) return fail(dbErrorMessage(readError));
  if (!current) return fail(NOT_FOUND_OR_FORBIDDEN);
  const siblings = await siblingsOf(context, orgId, current.parent_id);
  if (siblings.error) return fail(dbErrorMessage(siblings.error));
  const result = await reorder(context, orgId, "product_categories", siblings.data, categoryId, direction);
  if (result.ok) revalidateLists(orgId);
  return result;
}

/** Products in the category stay without one; its subcategories become top categories. */
export async function deleteCategoryAction(orgId: string, categoryId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, categoryId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.from("product_categories").delete().eq("organization_id", orgId).eq("id", categoryId).select("id");
  // a subcategory that would become a top category with the name of an existing one
  if (error?.code === "23505") return fail("לאחת מתתי-הקטגוריות יש שם של קטגוריה ראשית קיימת. שנו את השם שלה ונסו שוב.");
  if (error) return fail(dbErrorMessage(error));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidateLists(orgId);
  return ok();
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export async function addUnitAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = unitSchema.safeParse(pick(formData, ["name"]));
  if (!parsed.success) return invalid(parsed.error, formData);
  const existing = await unitsOf(context, orgId);
  if (existing.error) return fail(dbErrorMessage(existing.error), { values: formValues(formData) });
  const { error } = await context.supabase
    .from("product_units")
    .insert({ organization_id: orgId, name: parsed.data.name, position: existing.data.length });
  if (error) {
    return fail(error.code === "23505" ? UNIT_TAKEN : dbErrorMessage(error, "לא הצלחנו להוסיף את היחידה. נסו שוב."), { values: formValues(formData) });
  }
  revalidateLists(orgId);
  return ok();
}

export async function renameUnitAction(orgId: string, unitId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, unitId);
  if (!context.ok) return context;
  const parsed = unitSchema.safeParse(pick(formData, ["name"]));
  if (!parsed.success) return invalid(parsed.error, formData);
  const { data, error } = await context.supabase
    .from("product_units")
    .update({ name: parsed.data.name })
    .eq("organization_id", orgId)
    .eq("id", unitId)
    .select("id");
  if (error) {
    return fail(error.code === "23505" ? UNIT_TAKEN : dbErrorMessage(error, "לא הצלחנו לשמור. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidateLists(orgId);
  return ok();
}

export async function moveUnitAction(orgId: string, unitId: string, direction: "up" | "down"): Promise<ActionResult> {
  if (!validArg(directionArg, direction)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, unitId);
  if (!context.ok) return context;
  const units = await unitsOf(context, orgId);
  if (units.error) return fail(dbErrorMessage(units.error));
  const result = await reorder(context, orgId, "product_units", units.data, unitId, direction);
  if (result.ok) revalidateLists(orgId);
  return result;
}

/** A unit that products use is kept (the products foreign key has no cascade). */
export async function deleteUnitAction(orgId: string, unitId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, unitId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.from("product_units").delete().eq("organization_id", orgId).eq("id", unitId).select("id");
  if (error) return fail(error.code === "23503" ? UNIT_IN_USE : dbErrorMessage(error));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidateLists(orgId);
  return ok();
}
