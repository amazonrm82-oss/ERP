"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { actionContext } from "@/lib/action-context";
import { fail, FORM_INVALID, formValues, invalid, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { isUuid, paths } from "@/lib/paths";
import { checkbox, pick } from "@/lib/validation";

import { isFieldType, type FieldType } from "@/features/custom-fields/types";
import type { Database, Json } from "@/lib/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

import { formFieldOptions, storedFields } from "./fields";
import {
  CATEGORY_PICKS_VALUE,
  coveredCategoryIds,
  MAX_FORM_CATEGORIES,
  MAX_FORM_PRODUCTS,
  pickedCategoryIds,
  pickedProductIds,
  productOfferRefusal,
  PRODUCT_PICKS_VALUE,
  productPicksValue,
  PRODUCTS_KEPT_NOTE,
  PRODUCTS_KEPT_SAVED,
  PRODUCTS_NARROW_VALUE,
  sameProductSelection,
  type ProductSelection,
} from "./product";
import { marketingConsentSetting } from "./marketing-consent";
import { callbackSlotsOff, createIntakeSchema, fieldsFromForm, updateIntakeSchema } from "./schema";
import { defaultWhatsappButton, whatsappNumber } from "./whatsapp";

export async function createIntakeAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = createIntakeSchema.safeParse(pick(formData, ["name", "kind"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  // CAP-05: the thank-you WhatsApp button starts on only when the business phone is a valid number
  let whatsappButton = false;
  if (parsed.data.kind === "form") {
    const { data: org, error: orgError } = await context.supabase.from("organizations").select("phone").eq("id", orgId).maybeSingle();
    if (orgError) {
      return fail(dbErrorMessage(orgError, "לא הצלחנו ליצור. נסו שוב."), { values: formValues(formData) });
    }
    whatsappButton = defaultWhatsappButton(parsed.data.kind, org?.phone);
  }
  // leads of a new web form go to the person who made it, until changed
  const { data, error } = await context.supabase
    .from("forms")
    .insert({
      organization_id: orgId,
      kind: parsed.data.kind,
      name: parsed.data.name,
      title: parsed.data.kind === "form" ? parsed.data.name : null,
      owner_id: context.user.id,
      whatsapp_button: whatsappButton,
    })
    .select("id")
    .single();
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו ליצור. נסו שוב."), { values: formValues(formData) });
  }
  revalidatePath(paths.settingsIntake(orgId));
  redirect(paths.settingsIntakeItem(orgId, data.id));
}

export async function updateIntakeAction(orgId: string, formId: string, prev: FormState, formData: FormData): Promise<FormState> {
  const result = await updateIntake(orgId, formId, prev, formData);
  // LEAD-04 / CAP-08: formValues keeps one value per name; carry every ticked product back, so a failed save keeps the ticks
  if (result && !result.ok && result.values && formData.get(PRODUCT_SETTINGS_MARKER) === "1") {
    return {
      ...result,
      values: {
        ...result.values,
        [PRODUCT_PICKS_VALUE]: productPicksValue(formData.getAll("product_ids")),
        [CATEGORY_PICKS_VALUE]: productPicksValue(formData.getAll("product_category_ids")),
      },
    };
  }
  return result;
}

async function updateIntake(orgId: string, formId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, formId);
  if (!context.ok) {
    return context;
  }
  const parsed = updateIntakeSchema.safeParse(
    pick(formData, [
      "name",
      "title",
      "intro",
      "submit_label",
      "success_message",
      "redirect_url",
      "source_id",
      "owner_id",
      "team_id",
      "assign_mode",
      "is_active",
      "whatsapp_button",
      "whatsapp_phone",
      "whatsapp_text",
      "callback_choice",
      "channel_choice",
      "locale_choice",
    ]),
  );
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { data: current, error: currentError } = await context.supabase
    .from("forms")
    .select("kind, product_choice, product_ids, product_category_ids")
    .eq("organization_id", orgId)
    .eq("id", formId)
    .maybeSingle();
  if (currentError) return fail(dbErrorMessage(currentError));
  if (!current) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  let fields: Json | undefined;
  if (current.kind === "form") {
    // CAP-01: the builder's fields, checked against the business's lead fields
    const { data: definitions, error: definitionsError } = await context.supabase
      .from("field_definitions")
      .select("key, label, field_type, options, is_active")
      .eq("organization_id", orgId)
      .eq("object_type", "lead");
    if (definitionsError) return fail(dbErrorMessage(definitionsError));
    const options = formFieldOptions(
      definitions
        .filter((row) => isFieldType(row.field_type))
        .map((row) => ({
          id: row.key,
          key: row.key,
          label: row.label,
          type: row.field_type as FieldType,
          options: Array.isArray(row.options) ? row.options.filter((o): o is string => typeof o === "string") : [],
          isRequired: false,
          isActive: row.is_active,
          helpText: null,
        })),
    );
    const checked = fieldsFromForm(formData, options);
    if (!checked.ok) {
      return fail(checked.message, { values: formValues(formData) });
    }
    fields = storedFields(checked.fields);
  }
  // CAP-05: the WhatsApp button needs a number: the form's own, else the business phone
  if (current.kind === "form" && parsed.data.whatsapp_button && !parsed.data.whatsapp_phone) {
    const { data: org, error: orgError } = await context.supabase.from("organizations").select("phone").eq("id", orgId).maybeSingle();
    if (orgError) return fail(dbErrorMessage(orgError));
    if (!whatsappNumber(org?.phone)) {
      return fail(FORM_INVALID, {
        values: formValues(formData),
        fieldErrors: { whatsapp_phone: "יש להזין מספר ל-WhatsApp: בפרטי העסק אין מספר טלפון תקין." },
      });
    }
  }

  // LEAD-04 / CAP-08: the product question, only when the editor showed it (a web form of a business with products).
  // Owner, 26 October 2026 (answer (ב)): an unchanged selection is not sent (nor judged again), and a changed one that
  // offers more than 100 is left out: the other settings save, the stored selection stays, the field says why.
  let products: ProductPatch | Record<string, never> = {};
  let productsKept: string | null = null;
  if (current.kind === "form" && formData.get(PRODUCT_SETTINGS_MARKER) === "1") {
    const checked = await productSettings(context.supabase, orgId, formData, current);
    if (!checked.ok && checked.over) {
      productsKept = checked.message;
    } else if (!checked.ok) {
      return fail(FORM_INVALID, { values: formValues(formData), fieldErrors: { product_ids: checked.message } });
    } else if (checked.patch) {
      products = checked.patch;
    }
  }

  // CAP-05: webhooks keep their WhatsApp columns as they are; with the button off
  // only the switch is saved, and the stored number and text stay untouched
  const { whatsapp_button, whatsapp_phone, whatsapp_text, callback_choice, channel_choice, locale_choice, ...settings } = parsed.data;
  const thanks =
    current.kind !== "form" ? {} : whatsapp_button ? { whatsapp_button, whatsapp_phone, whatsapp_text } : { whatsapp_button };
  // SPD-05: a webhook has no form to ask on; its switch stays as it is. The slot
  // switches are saved only while the question is on, so turning it off keeps them
  // CON-10: the channel question too is a form's only
  const formOnly =
    current.kind !== "form"
      ? {}
      : {
          channel_choice,
          locale_choice,
          // CAP-07 / CNS-04: the marketing-consent boxes
          marketing_consent_channels: marketingConsentSetting(formData),
          ...(callback_choice ? { callback_choice, callback_slots_off: callbackSlotsOff(formData) } : { callback_choice }) };
  const save = (patch: ProductPatch | Record<string, never>) =>
    context.supabase
      .from("forms")
      .update({ ...settings, ...thanks, ...formOnly, ...patch, ...(fields !== undefined ? { fields } : {}) })
      .eq("organization_id", orgId)
      .eq("id", formId)
      .select("id");
  let { data, error } = await save(products);
  if (error?.hint === "form:products_over" && Object.keys(products).length > 0) {
    // the offer grew between the check and the save: the database refused the new selection; save the rest without it
    productsKept = dbErrorMessage(error);
    ({ data, error } = await save({}));
  }
  if (error) {
    // LEAD-04 / CAP-08: the product question's refusals answer on its field
    if (error.hint?.startsWith("form:product")) {
      return fail(FORM_INVALID, { values: formValues(formData), fieldErrors: { product_ids: dbErrorMessage(error) } });
    }
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור. נסו שוב."), { values: formValues(formData) });
  }
  if (!data || data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(paths.settingsIntake(orgId));
  revalidatePath(paths.settingsIntakeItem(orgId, formId));
  if (productsKept) {
    return fail(PRODUCTS_KEPT_SAVED, {
      values: { ...formValues(formData), [PRODUCTS_NARROW_VALUE]: "1" },
      fieldErrors: { product_ids: `${productsKept} ${PRODUCTS_KEPT_NOTE}` },
    });
  }
  return { ok: true, message: "נשמר." };
}

/** Deletes the form or webhook. Leads it created and its submission log stay (CAP-04). */
export async function deleteIntakeAction(orgId: string, formId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, formId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase.from("forms").delete().eq("organization_id", orgId).eq("id", formId).select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(paths.settingsIntake(orgId));
  redirect(paths.settingsIntake(orgId));
}

// LEAD-04 / CAP-08: the editor sends this marker with the product question's inputs
const PRODUCT_SETTINGS_MARKER = "product_settings";

type ProductPatch = { product_choice: boolean; product_ids: string[] | null; product_category_ids: string[] | null };

/**
 * The product question's columns from the settings form: asked or not, and every offerable product ("all") or the
 * picked products and categories. Picks are kept only when they are offerable products / categories of this business,
 * read with the user's session. While the question is asked, the offer may hold at most 100 offerable products (owner,
 * 25 October 2026); the database refuses the same (form:products_over), this answers on the field first.
 */
async function productSettings(
  supabase: SupabaseClient<Database>,
  orgId: string,
  formData: FormData,
  stored: ProductSelection,
): Promise<{ ok: true; patch: ProductPatch | null } | { ok: false; message: string; over?: true }> {
  const ask = checkbox.parse(formData.get("product_choice"));
  const ids = (name: string, max: number) =>
    formData
      .getAll(name)
      .filter((value): value is string => typeof value === "string" && isUuid(value))
      .slice(0, max * 2);
  const offerable = () =>
    supabase.from("products").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("is_active", true).is("archived_at", null);

  if (formData.get("product_scope") !== "picked") {
    const patch: ProductPatch = { product_choice: ask, product_ids: null, product_category_ids: null };
    if (sameProductSelection(stored, patch)) return { ok: true, patch: null };
    if (ask) {
      const { count, error } = await offerable();
      if (error) return { ok: false, message: dbErrorMessage(error) };
      const refusal = productOfferRefusal(ask, true, count ?? 0);
      if (refusal) return { ok: false, message: refusal, over: true };
    }
    return { ok: true, patch };
  }

  const sentProducts = ids("product_ids", MAX_FORM_PRODUCTS);
  const sentCategories = ids("product_category_ids", MAX_FORM_CATEGORIES);
  if (sentProducts.length > MAX_FORM_PRODUCTS) {
    return { ok: false, message: `אפשר לבחור עד ${MAX_FORM_PRODUCTS} מוצרים.` };
  }
  if (sentCategories.length > MAX_FORM_CATEGORIES) {
    return { ok: false, message: `אפשר לבחור עד ${MAX_FORM_CATEGORIES} קטגוריות.` };
  }
  // the stored pick sent back as it is (a product of it archived since, or a category deleted since, included) is unchanged
  const sent: ProductPatch = {
    product_choice: ask,
    product_ids: sentProducts.length > 0 ? sentProducts : null,
    product_category_ids: sentCategories.length > 0 ? sentCategories : null,
  };
  if ((sentProducts.length > 0 || sentCategories.length > 0) && sameProductSelection(stored, sent)) {
    return { ok: true, patch: null };
  }
  let offerableProducts = new Set<string>();
  if (sentProducts.length > 0) {
    const { data, error } = await supabase
      .from("products")
      .select("id")
      .eq("organization_id", orgId)
      .eq("is_active", true)
      .is("archived_at", null)
      .in("id", sentProducts);
    if (error) return { ok: false, message: dbErrorMessage(error) };
    offerableProducts = new Set(data.map((row) => row.id));
  }
  const { data: categoryRows, error: categoryError } = await supabase
    .from("product_categories")
    .select("id, parent_id")
    .eq("organization_id", orgId)
    .limit(1000);
  if (categoryError) return { ok: false, message: dbErrorMessage(categoryError) };
  const categories = categoryRows.map((row) => ({ id: row.id, name: "", parentId: row.parent_id }));
  const productIds = pickedProductIds(sentProducts, offerableProducts);
  const categoryIds = pickedCategoryIds(sentCategories, new Set(categories.map((c) => c.id)));
  if (productIds.length === 0 && categoryIds.length === 0) {
    if (ask) {
      return { ok: false, message: "יש לבחור לפחות מוצר או קטגוריה אחת, או להציג את כל המוצרים." };
    }
    const off: ProductPatch = { product_choice: false, product_ids: null, product_category_ids: null };
    return { ok: true, patch: sameProductSelection(stored, off) ? null : off };
  }
  const patch: ProductPatch = {
    product_choice: ask,
    product_ids: productIds.length > 0 ? productIds : null,
    product_category_ids: categoryIds.length > 0 ? categoryIds : null,
  };
  if (sameProductSelection(stored, patch)) {
    return { ok: true, patch: null };
  }
  if (ask) {
    const covered = [...coveredCategoryIds(categoryIds, categories)];
    const parts = [
      ...(productIds.length > 0 ? [`id.in.(${productIds.join(",")})`] : []),
      ...(covered.length > 0 ? [`category_id.in.(${covered.join(",")})`] : []),
    ];
    const { count, error } = await offerable().or(parts.join(","));
    if (error) return { ok: false, message: dbErrorMessage(error) };
    const refusal = productOfferRefusal(ask, false, count ?? 0);
    if (refusal) return { ok: false, message: refusal, over: true };
  }
  return { ok: true, patch };
}
