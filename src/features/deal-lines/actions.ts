"use server";

import { revalidatePath } from "next/cache";

import type { PriceListLineRule } from "@/features/price-lists/price";
import { productsPath } from "@/features/products/paths";
import type { Billing } from "@/features/products/schema";
import { orgHasFeature } from "@/features/settings/queries";
import { totalsErrorMessage } from "@/features/tax/calc";
import { actionContext } from "@/lib/action-context";
import { directionArg, INVALID_ARGS, optionalTextArg, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { isUuid, paths } from "@/lib/paths";
import { ilikeAny } from "@/lib/search";
import { pick } from "@/lib/validation";

import { priceListTiers, readDealLines, readDealPricing, readPricedProduct, type DealPricing } from "./queries";
import { lineTotal, priceOnEdit, pulledPrice, type PulledPrice } from "./pricing";
import { isBilling } from "./recurring";
import { DEAL_LINE_FIELD_NAMES, DEAL_LINES_MAX, dealLineSchema, QUICK_PRODUCT_FIELD_NAMES, quickProductSchema } from "./schema";

// DLI-01, DLI-02, PL-03. Every write goes with the user's session; rights follow the deal (RLS on
// deal_lines), so a person who may not edit the deal gets 42501 or 0 rows.

const CANNOT_EDIT = "אי אפשר לשנות את שורות העסקה. ייתכן שהעסקה בסל המחזור או שאין לכם הרשאה לערוך אותה.";
const PRODUCT_GONE = "המוצר שנבחר לא פעיל או בארכיון. בחרו מוצר פעיל מהקטלוג.";
const PRICE_MISSING = "בשורה בלי מוצר יש להזין מחיר.";
const TOO_MANY = `אפשר עד ${DEAL_LINES_MAX} שורות מוצר בעסקה אחת. מחקו שורה כדי להוסיף חדשה.`;
const SKU_TAKEN = 'המק"ט הזה כבר שייך למוצר אחר.';

type Ctx = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>;

function revalidateDeal(orgId: string, dealId: string) {
  revalidatePath(paths.deal(orgId, dealId));
  // DLI-03: a line change may move the deal's value, shown on the board and the lists
  revalidatePath(paths.deals(orgId));
}

function writeError(error: { code?: string; message?: string; hint?: string }): string {
  if (error.code === "42501") return CANNOT_EDIT;
  return dbErrorMessage(error);
}

/** The deal's customer and the business's time zone, read with the user's session; null when not readable. */
async function readDeal(context: Ctx, orgId: string, dealId: string) {
  const [{ data: deal, error }, { data: org, error: orgError }] = await Promise.all([
    context.supabase.from("deals").select("contact_id, company_id").eq("organization_id", orgId).eq("id", dealId).maybeSingle(),
    context.supabase.from("organizations").select("timezone").eq("id", orgId).maybeSingle(),
  ]);
  if (error || orgError) return { error: error ?? orgError };
  if (!deal || !org) return { error: null, deal: null };
  return { error: null, deal: { contactId: deal.contact_id, companyId: deal.company_id }, timeZone: org.timezone };
}

/** PL-03: the automatic unit price of a product on this deal, in the deal's mode. */
async function automaticPrice(context: Ctx, orgId: string, pricing: DealPricing, productId: string, quantity: number): Promise<PulledPrice | null> {
  const product = await readPricedProduct(context.supabase, orgId, productId);
  if (!product) return null;
  const tiers = pricing.list ? await priceListTiers(context.supabase, orgId, pricing.list.id, [product.id]) : [];
  const list = pricing.list ? { ...pricing.list, lines: tiers } : null;
  return pulledPrice(product, list, quantity, pricing.day, pricing.includesVat, pricing.rateBp);
}

function checkAmounts(
  input: { quantity: number; unitPriceAgorot: number; discountBp: number | null; discountAgorot: number | null },
  includesVat: boolean,
): Record<string, string> | null {
  const result = lineTotal({ ...input, vatExempt: false }, includesVat);
  if (result.ok) return null;
  const field = result.error === "quantity" ? "quantity" : result.error === "price" || result.error === "amount" ? "unit_price" : "discount";
  return { [field]: totalsErrorMessage(result.error) };
}

/** DLI-01: a new line at the end of the deal. An empty price on a product line takes the automatic price (PL-03). */
async function addLine(orgId: string, dealId: string, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, dealId);
  if (!context.ok) return context;
  const parsed = dealLineSchema.safeParse(pick(formData, DEAL_LINE_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  const input = parsed.data;
  const values = formValues(formData);

  const read = await readDeal(context, orgId, dealId);
  if (read.error) return fail(dbErrorMessage(read.error), { values });
  if (!read.deal) return fail(NOT_FOUND_OR_FORBIDDEN, { values });
  const lines = await readDealLines(context.supabase, orgId, dealId);
  if (lines.length >= DEAL_LINES_MAX) return fail(TOO_MANY, { values });
  const pricing = await readDealPricing(context.supabase, orgId, read.deal, lines, read.timeZone);

  let price: { agorot: number; source: "product" | "price_list" | "manual"; listId: string | null };
  if (input.productId) {
    const product = await readPricedProduct(context.supabase, orgId, input.productId);
    if (!product || !product.offerable) return fail(PRODUCT_GONE, { fieldErrors: { product_id: PRODUCT_GONE }, values });
    if (input.unitPriceAgorot === null) {
      const pulled = await automaticPrice(context, orgId, pricing, product.id, input.quantity);
      if (!pulled) return fail(PRODUCT_GONE, { values });
      price = { agorot: pulled.priceAgorot, source: pulled.source, listId: pulled.priceListId };
    } else {
      price = { agorot: input.unitPriceAgorot, source: "manual", listId: null };
    }
  } else {
    if (input.unitPriceAgorot === null) return fail(PRICE_MISSING, { fieldErrors: { unit_price: PRICE_MISSING }, values });
    price = { agorot: input.unitPriceAgorot, source: "manual", listId: null };
  }
  const amounts = { quantity: input.quantity, unitPriceAgorot: price.agorot, discountBp: input.discountBp, discountAgorot: input.discountAgorot };
  const fieldErrors = checkAmounts(amounts, pricing.includesVat);
  if (fieldErrors) return fail(Object.values(fieldErrors)[0], { fieldErrors, values });

  const position = lines.reduce((max, line) => Math.max(max, line.position), 0) + 1;
  const { error } = await context.supabase.from("deal_lines").insert({
    organization_id: orgId,
    deal_id: dealId,
    position: Math.min(position, 100000),
    product_id: input.productId,
    description: input.description,
    quantity: input.quantity,
    unit_price_agorot: price.agorot,
    discount_bp: input.discountBp,
    discount_agorot: input.discountAgorot,
    price_includes_vat: pricing.includesVat,
    // a free line's own choice; a product line's comes from the product (the trigger overrides it)
    ...(input.productId === null ? { vat_exempt: input.vatExempt ?? false } : {}),
    // DLI-04: a free line's billing is the person's (one-time by default); a product line's is the product's (trigger)
    ...(input.productId === null ? { billing: input.billing ?? "one_time" } : {}),
    price_source: price.source,
    price_list_id: price.listId,
  });
  if (error) return fail(writeError(error), { values });
  revalidateDeal(orgId, dealId);
  return ok(undefined, "השורה נוספה.");
}

/**
 * DLI-01: change a line's description, quantity, price or discount. The price is a snapshot:
 * - a price the person typed (different from the stored one) is kept as theirs ("manual");
 * - an emptied price box on a product line takes the automatic price again;
 * - a changed quantity re-pulls the automatic price (a quantity tier may apply), but only
 *   while the line's price is still the automatic one.
 * Nothing else ever changes a saved line: a later change of the product or the list does not.
 */
async function updateLine(orgId: string, dealId: string, lineId: string, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, dealId, lineId);
  if (!context.ok) return context;
  const parsed = dealLineSchema.safeParse(pick(formData, DEAL_LINE_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  const input = parsed.data;
  const values = formValues(formData);

  const lines = await readDealLines(context.supabase, orgId, dealId);
  const stored = lines.find((line) => line.id === lineId);
  if (!stored) return fail(NOT_FOUND_OR_FORBIDDEN, { values });

  const decision = priceOnEdit(
    { unitPriceAgorot: stored.unitPriceAgorot, quantity: stored.quantity, source: stored.source, hasProduct: stored.productId !== null },
    input.unitPriceAgorot,
    input.quantity,
  );
  let patch: { unit_price_agorot: number; price_source: "product" | "price_list" | "manual"; price_list_id: string | null } = {
    unit_price_agorot: stored.unitPriceAgorot,
    price_source: stored.source,
    price_list_id: stored.priceListId,
  };
  if (decision === "missing") return fail(PRICE_MISSING, { fieldErrors: { unit_price: PRICE_MISSING }, values });
  if (decision === "manual" && input.unitPriceAgorot !== null) {
    patch = { unit_price_agorot: input.unitPriceAgorot, price_source: "manual", price_list_id: null };
  } else if (decision === "pull" && stored.productId) {
    const read = await readDeal(context, orgId, dealId);
    if (read.error) return fail(dbErrorMessage(read.error), { values });
    if (!read.deal) return fail(NOT_FOUND_OR_FORBIDDEN, { values });
    const pricing = await readDealPricing(context.supabase, orgId, read.deal, lines, read.timeZone);
    const pulled = await automaticPrice(context, orgId, pricing, stored.productId, input.quantity);
    if (!pulled) return fail(PRODUCT_GONE, { values });
    patch = { unit_price_agorot: pulled.priceAgorot, price_source: pulled.source, price_list_id: pulled.priceListId };
  }
  const amounts = { quantity: input.quantity, unitPriceAgorot: patch.unit_price_agorot, discountBp: input.discountBp, discountAgorot: input.discountAgorot };
  const fieldErrors = checkAmounts(amounts, stored.priceIncludesVat);
  if (fieldErrors) return fail(Object.values(fieldErrors)[0], { fieldErrors, values });

  // a list price kept as it was keeps its list (and its name, even when the list was removed)
  const sameList = patch.price_source === stored.source && patch.price_list_id === stored.priceListId;
  const { data, error } = await context.supabase
    .from("deal_lines")
    .update({
      description: input.description,
      quantity: input.quantity,
      unit_price_agorot: patch.unit_price_agorot,
      discount_bp: input.discountBp,
      discount_agorot: input.discountAgorot,
      ...(stored.productId === null && input.vatExempt !== null ? { vat_exempt: input.vatExempt } : {}),
      ...(stored.productId === null && input.billing !== null ? { billing: input.billing } : {}),
      ...(sameList ? {} : { price_source: patch.price_source, price_list_id: patch.price_list_id }),
    })
    .eq("organization_id", orgId)
    .eq("deal_id", dealId)
    .eq("id", lineId)
    .select("id");
  if (error) return fail(writeError(error), { values });
  if (data.length === 0) return fail(CANNOT_EDIT, { values });
  revalidateDeal(orgId, dealId);
  return ok(undefined, "השורה עודכנה.");
}

/** DLI-01: a new line at the end of the deal (addLine). A failed read answers with the plain error. */
export async function addDealLineAction(orgId: string, dealId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  try {
    return await addLine(orgId, dealId, formData);
  } catch {
    return fail(dbErrorMessage(null), { values: formValues(formData) });
  }
}

/** DLI-01: change a line (updateLine). */
export async function updateDealLineAction(orgId: string, dealId: string, lineId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  try {
    return await updateLine(orgId, dealId, lineId, formData);
  } catch {
    return fail(dbErrorMessage(null), { values: formValues(formData) });
  }
}

export async function deleteDealLineAction(orgId: string, dealId: string, lineId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, dealId, lineId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("deal_lines")
    .delete()
    .eq("organization_id", orgId)
    .eq("deal_id", dealId)
    .eq("id", lineId)
    .select("id");
  if (error) return fail(writeError(error));
  if (data.length === 0) return fail(CANNOT_EDIT);
  revalidateDeal(orgId, dealId);
  return ok();
}

/** Moves a line one place up or down; the lines are numbered again from 1 (only changed ones are written). */
export async function moveDealLineAction(orgId: string, dealId: string, lineId: string, direction: unknown): Promise<ActionResult> {
  if (!validArg(directionArg, direction)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, dealId, lineId);
  if (!context.ok) return context;
  let lines;
  try {
    lines = await readDealLines(context.supabase, orgId, dealId);
  } catch {
    return fail(dbErrorMessage(null));
  }
  const index = lines.findIndex((line) => line.id === lineId);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  if (target < 0 || target >= lines.length) return ok();
  const order = [...lines];
  [order[index], order[target]] = [order[target], order[index]];
  for (const [i, line] of order.entries()) {
    if (line.position === i + 1) continue;
    const { data, error } = await context.supabase
      .from("deal_lines")
      .update({ position: i + 1 })
      .eq("organization_id", orgId)
      .eq("deal_id", dealId)
      .eq("id", line.id)
      .select("id");
    if (error) return fail(writeError(error));
    if (data.length === 0) return fail(CANNOT_EDIT);
  }
  revalidateDeal(orgId, dealId);
  return ok();
}

// DLI-02 ----------------------------------------------------------------------

export type ProductHit = {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  priceAgorot: number;
  priceIncludesVat: boolean;
  vatKind: "taxable" | "exempt" | "zero_rate";
  // DLI-04: how the product bills; a line made from it copies this
  billing: Billing;
  // the customer's price list tiers for this product (PL-03), so the form shows the price it will get
  tiers: PriceListLineRule[];
};

/**
 * DLI-02: offerable products (active, not archived) by name, SKU or barcode; the first 20 by name
 * for an empty query. listId is the customer's price list the page found; its tiers come along.
 * Read with the user's session (every member reads the catalog).
 */
export async function searchDealProductsAction(orgId: string, query: unknown, listId: unknown): Promise<ProductHit[]> {
  if (!validArg(optionalTextArg(100), query) || (listId !== null && (typeof listId !== "string" || !isUuid(listId)))) return [];
  const context = await actionContext(orgId);
  if (!context.ok) return [];
  let request = context.supabase
    .from("products")
    .select("id, name, sku, barcode, price_agorot, price_includes_vat, vat_kind, billing")
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .is("archived_at", null);
  const q = (query ?? "").trim();
  if (q !== "") {
    const filter = ilikeAny(["name", "sku", "barcode"], q);
    if (!filter) return [];
    request = request.or(filter);
  }
  const { data, error } = await request.order("name").order("id").limit(20);
  if (error) return [];
  let tiers: PriceListLineRule[] = [];
  // PL-03: a list's tiers only while the plan holds price lists
  if (listId && data.length > 0) {
    try {
      tiers = !(await orgHasFeature(orgId, "price_lists")) ? [] : await priceListTiers(
        context.supabase,
        orgId,
        listId,
        data.map((row) => row.id),
      );
    } catch {
      tiers = [];
    }
  }
  return data.map((row) => ({
    id: row.id,
    name: row.name,
    sku: row.sku,
    barcode: row.barcode,
    priceAgorot: Number(row.price_agorot),
    priceIncludesVat: row.price_includes_vat,
    vatKind: row.vat_kind === "exempt" || row.vat_kind === "zero_rate" ? row.vat_kind : "taxable",
    billing: isBilling(row.billing) ? row.billing : "one_time",
    tiers: tiers.filter((tier) => tier.productId === row.id),
  }));
}

/**
 * DLI-02: a quick product from the picker, for owners and admins of a writable business (RLS on
 * products refuses everyone else; the products flag and the max_products quota are checked by
 * trigger products_quota). A taxable product, priced in the deal's VAT mode, so the typed price
 * is the price the line gets.
 */
export async function quickCreateProductAction(orgId: string, dealId: string, _prev: FormState<ProductHit>, formData: FormData): Promise<FormState<ProductHit>> {
  const context = await actionContext(orgId, dealId);
  if (!context.ok) return context;
  const parsed = quickProductSchema.safeParse(pick(formData, QUICK_PRODUCT_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  const values = formValues(formData);
  let includesVat: boolean;
  try {
    const lines = await readDealLines(context.supabase, orgId, dealId);
    if (lines.length > 0) {
      includesVat = lines[0].priceIncludesVat;
    } else {
      const { data: settings, error } = await context.supabase.from("org_document_settings").select("prices_include_vat").eq("organization_id", orgId).maybeSingle();
      if (error) return fail(dbErrorMessage(error), { values });
      includesVat = settings?.prices_include_vat === true;
    }
  } catch {
    return fail(dbErrorMessage(null), { values });
  }
  const { data, error } = await context.supabase
    .from("products")
    .insert({
      organization_id: orgId,
      name: parsed.data.name,
      sku: parsed.data.sku,
      price_agorot: parsed.data.price,
      price_includes_vat: includesVat,
      vat_kind: "taxable",
      kind: "product",
      billing: "one_time",
      is_active: true,
    })
    .select("id, name, sku, barcode, price_agorot, price_includes_vat")
    .single();
  if (error) {
    if (error.code === "23505") return fail(SKU_TAKEN, { fieldErrors: { sku: SKU_TAKEN }, values });
    if (error.code === "42501") return fail("רק בעלי העסק ומנהלי מערכת יוצרים מוצרים.", { values });
    return fail(dbErrorMessage(error), { values });
  }
  revalidatePath(productsPath(orgId));
  return ok({
    id: data.id,
    name: data.name,
    sku: data.sku,
    barcode: data.barcode,
    priceAgorot: Number(data.price_agorot),
    priceIncludesVat: data.price_includes_vat,
    vatKind: "taxable",
    billing: "one_time",
    tiers: [],
  });
}
