"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { priceListTiers, readPricedProduct } from "@/features/deal-lines/queries";
import { lineTotal, pulledPrice } from "@/features/deal-lines/pricing";
import { totalsErrorMessage } from "@/features/tax/calc";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { orderPath, ordersPath } from "./paths";
import { readOrder, readOrderPricing, type Order } from "./queries";
import { MOVABLE_STATUSES, ORDER_DETAILS_FIELD_NAMES, ORDER_LINE_DESCRIPTION_MAX, ORDER_LINE_FIELD_NAMES, orderDetailsSchema, orderLineSchema } from "./schema";

// ORD-01 / ORD-02 / ORD-03. Every write goes with the user's session; rights follow the order's deal, else its contact,
// else its company (RLS on orders and order_lines), so a person who may not edit them gets 42501 or 0 rows. Numbers come
// only from the database (order_confirm, order_from_quote, order_from_deal).

const CANNOT_EDIT = "אי אפשר לשנות את ההזמנה. ייתכן שהיא בוטלה, שהרשומה שלה בסל המחזור, או שאין לכם הרשאה לערוך אותה.";
const CANNOT_CREATE = "אין לכם הרשאה ליצור הזמנה לרשומה הזו.";
const FAILED = "לא הצלחנו ליצור את ההזמנה. נסו שוב.";

function revalidateOrder(orgId: string, order: Pick<Order, "id" | "dealId" | "contactId" | "companyId">) {
  revalidatePath(orderPath(orgId, order.id));
  revalidatePath(ordersPath(orgId));
  if (order.dealId) revalidatePath(paths.deal(orgId, order.dealId));
  if (order.contactId) revalidatePath(paths.contact(orgId, order.contactId));
  if (order.companyId) revalidatePath(paths.company(orgId, order.companyId));
}

function writeError(error: { code?: string; message?: string; hint?: string }): string {
  if (error.code === "42501") return CANNOT_EDIT;
  return dbErrorMessage(error);
}

const sourceArg = z.object({ kind: z.enum(["deal", "contact", "company"]), id: z.guid() });

/**
 * ORD-01: a manual draft for a deal (its contact and company come with it), a contact (its company comes with it) or a
 * company. The shipping address is copied once by the database. The order page opens.
 */
export async function createOrderAction(orgId: string, source: unknown): Promise<ActionResult> {
  if (!validArg(sourceArg, source)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, source.id);
  if (!context.ok) return context;
  const parent = source.kind === "deal" ? { deal_id: source.id } : source.kind === "contact" ? { contact_id: source.id } : { company_id: source.id };
  const { data, error } = await context.supabase
    .from("orders")
    .insert({ organization_id: orgId, ...parent })
    .select("id, deal_id, contact_id, company_id")
    .single();
  if (error) return fail(error.code === "42501" ? CANNOT_CREATE : dbErrorMessage(error));
  revalidateOrder(orgId, { id: data.id, dealId: data.deal_id, contactId: data.contact_id, companyId: data.company_id });
  redirect(orderPath(orgId, data.id));
}

/** ORD-01 (owner (2)): the delivery details, on every order that is not cancelled. */
export async function updateOrderDetailsAction(orgId: string, orderId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = orderDetailsSchema.safeParse(pick(formData, ORDER_DETAILS_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  const context = await actionContext(orgId, orderId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("orders")
    .update(parsed.data)
    .eq("organization_id", orgId)
    .eq("id", orderId)
    .select("id, deal_id, contact_id, company_id");
  if (error) return fail(writeError(error));
  if (data.length === 0) return fail(CANNOT_EDIT);
  revalidateOrder(orgId, { id: orderId, dealId: data[0].deal_id, contactId: data[0].contact_id, companyId: data[0].company_id });
  return { ok: true, message: "הפרטים נשמרו." };
}

const statusArg = z.enum([...MOVABLE_STATUSES, "cancelled"]);

/** ORD-02: moves a numbered order between its states, or cancels it (a cancelled order stays cancelled). */
export async function setOrderStatusAction(orgId: string, orderId: string, status: unknown): Promise<ActionResult> {
  if (!validArg(statusArg, status)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, orderId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("orders")
    .update({ status })
    .eq("organization_id", orgId)
    .eq("id", orderId)
    .select("id, deal_id, contact_id, company_id");
  if (error) return fail(writeError(error));
  if (data.length === 0) return fail(CANNOT_EDIT);
  revalidateOrder(orgId, { id: orderId, dealId: data[0].deal_id, contactId: data[0].contact_id, companyId: data[0].company_id });
  return ok();
}

/** ORD-03: a manual draft gets its number (public.order_confirm); its lines and prices are locked from then on. */
export async function confirmOrderAction(orgId: string, orderId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, orderId);
  if (!context.ok) return context;
  const { error } = await context.supabase.rpc("order_confirm", { p_org: orgId, p_order: orderId });
  if (error) return fail(writeError(error));
  const order = await readOrder(context.supabase, orgId, orderId);
  if (order) revalidateOrder(orgId, order);
  return ok();
}

/** A draft is deleted (a numbered order is only cancelled; the database refuses it). */
export async function deleteOrderAction(orgId: string, orderId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, orderId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.from("orders").delete().eq("organization_id", orgId).eq("id", orderId).select("id, deal_id, contact_id, company_id");
  if (error) return fail(writeError(error));
  if (data.length === 0) return fail(CANNOT_EDIT);
  const row = data[0];
  revalidateOrder(orgId, { id: orderId, dealId: row.deal_id, contactId: row.contact_id, companyId: row.company_id });
  redirect(
    row.deal_id ? paths.deal(orgId, row.deal_id) : row.contact_id ? paths.contact(orgId, row.contact_id) : row.company_id ? paths.company(orgId, row.company_id) : ordersPath(orgId),
  );
}

const PRODUCT_GONE = "המוצר שנבחר לא פעיל או בארכיון. בחרו מוצר פעיל מהקטלוג.";
const PRICE_MISSING = "בשורה בלי מוצר יש להזין מחיר.";

/**
 * A line on a draft: a product (its price, when left empty, is the automatic one: the customer's price list with its
 * tiers, else the product's own price, PL-03 as on deal lines and quotes) or a free line with a typed price.
 */
async function addLine(orgId: string, orderId: string, formData: FormData): Promise<FormState> {
  const parsed = orderLineSchema.safeParse(pick(formData, ORDER_LINE_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  const input = parsed.data;
  const values = formValues(formData);
  const context = await actionContext(orgId, orderId);
  if (!context.ok) return context;
  const { supabase } = context;
  const order = await readOrder(supabase, orgId, orderId);
  if (!order) return fail(NOT_FOUND_OR_FORBIDDEN, { values });

  let price: { agorot: number; source: "product" | "price_list" | "manual"; listId: string | null };
  let description = input.description;
  if (input.productId) {
    const product = await readPricedProduct(supabase, orgId, input.productId);
    if (!product || !product.offerable) return fail(PRODUCT_GONE, { fieldErrors: { product_id: PRODUCT_GONE }, values });
    if (!description && product.description) description = product.description.slice(0, ORDER_LINE_DESCRIPTION_MAX);
    if (input.unitPriceAgorot === null) {
      const pricing = await readOrderPricing(supabase, orgId, order);
      const tiers = pricing.list ? await priceListTiers(supabase, orgId, pricing.list.id, [product.id]) : [];
      const pulled = pulledPrice(product, pricing.list ? { ...pricing.list, lines: tiers } : null, input.quantity, pricing.day, pricing.includesVat, pricing.rateBp);
      price = { agorot: pulled.priceAgorot, source: pulled.source, listId: pulled.priceListId };
    } else {
      price = { agorot: input.unitPriceAgorot, source: "manual", listId: null };
    }
  } else {
    if (input.unitPriceAgorot === null) return fail(PRICE_MISSING, { fieldErrors: { unit_price: PRICE_MISSING }, values });
    price = { agorot: input.unitPriceAgorot, source: "manual", listId: null };
  }
  // the line's amount must be sound before the database works it out again (discount above the line, too large a total)
  const checked = lineTotal(
    { quantity: input.quantity, unitPriceAgorot: price.agorot, discountBp: input.discountBp, discountAgorot: input.discountAgorot, vatExempt: false },
    order.pricesIncludeVat,
  );
  if (!checked.ok) {
    const field = checked.error === "quantity" ? "quantity" : checked.error === "price" || checked.error === "amount" ? "unit_price" : "discount";
    const message = totalsErrorMessage(checked.error);
    return fail(message, { fieldErrors: { [field]: message }, values });
  }

  const { data: last, error: lastError } = await supabase
    .from("order_lines")
    .select("position")
    .eq("organization_id", orgId)
    .eq("order_id", orderId)
    .order("position", { ascending: false })
    .limit(1);
  if (lastError) return fail(dbErrorMessage(lastError), { values });
  const { error } = await supabase.from("order_lines").insert({
    organization_id: orgId,
    order_id: orderId,
    position: Math.min((last[0]?.position ?? -1) + 1, 100000),
    product_id: input.productId,
    name: input.name,
    description,
    quantity: input.quantity,
    unit_price_agorot: price.agorot,
    discount_bp: input.discountBp,
    discount_agorot: input.discountAgorot,
    // a free line's own choices; a product line's come from the product (the trigger sets them)
    ...(input.productId === null ? { vat_exempt: input.vatExempt ?? false, billing: input.billing ?? "one_time" } : {}),
    price_source: price.source,
    price_list_id: price.listId,
  });
  if (error) return fail(writeError(error), { values });
  revalidateOrder(orgId, order);
  return { ok: true, message: "השורה נוספה." };
}

export async function addOrderLineAction(orgId: string, orderId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  try {
    return await addLine(orgId, orderId, formData);
  } catch {
    return fail(dbErrorMessage(null), { values: formValues(formData) });
  }
}

/** Removes a line of a draft. */
export async function deleteOrderLineAction(orgId: string, orderId: string, lineId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, orderId, lineId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.from("order_lines").delete().eq("organization_id", orgId).eq("order_id", orderId).eq("id", lineId).select("id");
  if (error) return fail(writeError(error));
  if (data.length === 0) return fail(CANNOT_EDIT);
  const order = await readOrder(context.supabase, orgId, orderId);
  if (order) revalidateOrder(orgId, order);
  return ok();
}

/** ORD-01 (owner (2), (3)): an order from an accepted quote, numbered at once with the accepted lines and prices. */
export async function orderFromQuoteAction(orgId: string, quoteId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, quoteId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("order_from_quote", { p_org: orgId, p_quote: quoteId });
  if (error) return fail(writeError(error));
  if (typeof data !== "string") return fail(FAILED);
  const order = await readOrder(context.supabase, orgId, data);
  if (!order) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidateOrder(orgId, order);
  revalidatePath(`/o/${orgId}/quotes/${quoteId}`);
  redirect(orderPath(orgId, data));
}

/** ORD-01 (owner (4)): an order from a won deal without an accepted quote; its lines copied as they are, numbered at once. */
export async function orderFromDealAction(orgId: string, dealId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, dealId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("order_from_deal", { p_org: orgId, p_deal: dealId });
  if (error) return fail(writeError(error));
  if (typeof data !== "string") return fail(FAILED);
  const order = await readOrder(context.supabase, orgId, data);
  if (!order) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidateOrder(orgId, order);
  redirect(orderPath(orgId, data));
}
