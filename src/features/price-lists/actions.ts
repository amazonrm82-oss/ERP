"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { priceListPath, priceListsPath } from "./paths";
import { PRICE_LIST_FIELD_NAMES, priceListSchema, type PriceListInput } from "./schema";

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
