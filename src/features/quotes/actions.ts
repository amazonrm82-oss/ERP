"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { priceListTiers, readPricedProduct } from "@/features/deal-lines/queries";
import { lineTotal, priceOnEdit, pulledPrice } from "@/features/deal-lines/pricing";
import { totalsErrorMessage } from "@/features/tax/calc";
import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { addDays } from "@/lib/calendar-grid";
import { zoneDate } from "@/lib/format";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { siteOrigin } from "@/lib/site-origin";

import { quotePath } from "./paths";
import { publicQuotePath, QUOTE_LINK_TOKEN } from "./public";
import { readQuote, readQuoteLines, readQuotePricing, type Quote, type QuotePricing } from "./queries";
import { applyTemplateToQuote } from "./template-server";
import {
  DEFAULT_VALID_DAYS,
  defaultQuoteTitle,
  QUOTE_HEADER_FIELD_NAMES,
  QUOTE_LINE_DESCRIPTION_MAX,
  QUOTE_LINE_FIELD_NAMES,
  QUOTE_LINES_MAX,
  quoteGroupSchema,
  quoteHeaderSchema,
  quoteLineSchema,
} from "./schema";

// QUO-01, QUO-02. Every write goes with the user's session; rights follow the quote's deal, else its
// contact (RLS on quotes and quote_lines), so a person who may not edit them gets 42501 or 0 rows.

const CANNOT_EDIT = "אי אפשר לשנות את ההצעה. ייתכן שהיא כבר לא טיוטה, שהעסקה או איש הקשר בסל המחזור, או שאין לכם הרשאה לערוך אותם.";
const CANNOT_CREATE = "אין לכם הרשאה ליצור הצעת מחיר לרשומה הזו.";
const PRODUCT_GONE = "המוצר שנבחר לא פעיל או בארכיון. בחרו מוצר פעיל מהקטלוג.";
const PRICE_MISSING = "בשורה בלי מוצר יש להזין מחיר.";
const TOO_MANY = `אפשר עד ${QUOTE_LINES_MAX} שורות בהצעה אחת. מחקו שורה כדי להוסיף חדשה.`;
const DISCOUNT_TOO_LARGE = "ההנחה על ההצעה גדולה מסכום השורות. הקטינו את ההנחה ונסו שוב.";

type Ctx = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>;

function revalidateQuote(orgId: string, quote: Pick<Quote, "id" | "dealId" | "contactId">) {
  revalidatePath(quotePath(orgId, quote.id));
  if (quote.dealId) revalidatePath(paths.deal(orgId, quote.dealId));
  if (quote.contactId) revalidatePath(paths.contact(orgId, quote.contactId));
}

function writeError(error: { code?: string; message?: string; hint?: string }): string {
  if (error.code === "42501") return CANNOT_EDIT;
  if (error.hint === "totals:invalid" && error.message?.includes("discount_too_large")) return DISCOUNT_TOO_LARGE;
  return dbErrorMessage(error);
}

// QUO-01 --------------------------------------------------------------------

const sourceArg = z.object({ kind: z.enum(["deal", "contact"]), id: z.guid() });

/**
 * QUO-01: a new draft from a deal (its contact and company come with it) or from a contact (its company
 * comes with it), titled after the deal or the contact and valid for 30 days; then the editor opens.
 */
export async function createQuoteAction(orgId: string, source: unknown, templateId: unknown = null): Promise<ActionResult> {
  if (!validArg(sourceArg, source)) return fail(INVALID_ARGS);
  // QUO-04: a template to start from (its lines, notes and terms)
  if (templateId !== null && !validArg(z.guid(), templateId)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, source.id);
  if (!context.ok) return context;
  const { supabase } = context;
  const parent =
    source.kind === "deal"
      ? await supabase.from("deals").select("name").eq("organization_id", orgId).eq("id", source.id).maybeSingle()
      : await supabase.from("contacts").select("full_name").eq("organization_id", orgId).eq("id", source.id).maybeSingle();
  if (parent.error) return fail(dbErrorMessage(parent.error));
  if (!parent.data) return fail(NOT_FOUND_OR_FORBIDDEN);
  const name = "name" in parent.data ? parent.data.name : parent.data.full_name;
  const { data: org, error: orgError } = await supabase.from("organizations").select("timezone").eq("id", orgId).maybeSingle();
  if (orgError) return fail(dbErrorMessage(orgError));
  const today = zoneDate(new Date(), org?.timezone ?? undefined);
  const { data, error } = await supabase
    .from("quotes")
    .insert({
      organization_id: orgId,
      title: defaultQuoteTitle(name),
      valid_until: addDays(today, DEFAULT_VALID_DAYS),
      ...(source.kind === "deal" ? { deal_id: source.id } : { contact_id: source.id }),
    })
    .select("id, deal_id, contact_id")
    .single();
  if (error) return fail(error.code === "42501" ? CANNOT_CREATE : dbErrorMessage(error));
  revalidateQuote(orgId, { id: data.id, dealId: data.deal_id, contactId: data.contact_id });
  if (templateId === null) redirect(quotePath(orgId, data.id));
  const quote = await readQuote(supabase, orgId, data.id);
  const applied = quote ? await applyTemplateToQuote(supabase, orgId, quote, templateId) : null;
  // the quote exists either way; the editor says what came from the template
  redirect(
    `${quotePath(orgId, data.id)}?${
      applied?.ok ? new URLSearchParams({ template: "ok", added: String(applied.added), skipped: String(applied.skipped) }) : "template=failed"
    }`,
  );
}

// QUO-02: the quote's own details ---------------------------------------------

export async function updateQuoteAction(orgId: string, quoteId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, quoteId);
  if (!context.ok) return context;
  const parsed = quoteHeaderSchema.safeParse(pick(formData, QUOTE_HEADER_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  const input = parsed.data;
  const values = formValues(formData);
  let quote: Quote | null;
  try {
    quote = await readQuote(context.supabase, orgId, quoteId);
  } catch {
    return fail(dbErrorMessage(null), { values });
  }
  if (!quote) return fail(NOT_FOUND_OR_FORBIDDEN, { values });
  if (input.validUntil && input.validUntil < quote.quoteDate) {
    return fail("התוקף לא יכול להיות לפני תאריך ההצעה.", { fieldErrors: { valid_until: "התוקף לא יכול להיות לפני תאריך ההצעה." }, values });
  }
  const { data, error } = await context.supabase
    .from("quotes")
    .update({
      title: input.title,
      valid_until: input.validUntil,
      notes: input.notes,
      terms: input.terms,
      discount_bp: input.discountBp,
      discount_agorot: input.discountAgorot,
      ...(input.noVat ? { no_vat_reason: input.noVat.reason, no_vat_note: input.noVat.note } : {}),
    })
    .eq("organization_id", orgId)
    .eq("id", quoteId)
    .select("id");
  if (error) {
    if (error.code === "23514" && error.message.includes("quotes_no_vat_mode")) {
      return fail('הצעה בלי מע"מ נכתבת במחירים לפני מע"מ. מחקו את השורות או צרו הצעה חדשה במחירים לפני מע"מ.', { values });
    }
    return fail(writeError(error), { values });
  }
  if (data.length === 0) return fail(CANNOT_EDIT, { values });
  revalidateQuote(orgId, quote);
  return { ok: true, message: "ההצעה נשמרה כטיוטה." };
}

/** QUO-02: the prices of a quote with no lines yet may be typed including or before VAT. */
export async function setQuoteVatModeAction(orgId: string, quoteId: string, includesVat: unknown): Promise<ActionResult> {
  if (typeof includesVat !== "boolean") return fail(INVALID_ARGS);
  const context = await actionContext(orgId, quoteId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("quotes")
    .update({ prices_include_vat: includesVat })
    .eq("organization_id", orgId)
    .eq("id", quoteId)
    .select("id, deal_id, contact_id");
  if (error) {
    if (error.code === "23514") return fail('בהצעה בלי מע"מ המחירים נכתבים לפני מע"מ.');
    return fail(writeError(error));
  }
  if (data.length === 0) return fail(CANNOT_EDIT);
  revalidateQuote(orgId, { id: quoteId, dealId: data[0].deal_id, contactId: data[0].contact_id });
  return ok();
}

/** A draft is removed for good (a sent quote is cancelled instead, QUO-11). */
export async function deleteQuoteAction(orgId: string, quoteId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, quoteId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.from("quotes").delete().eq("organization_id", orgId).eq("id", quoteId).select("id, deal_id, contact_id");
  if (error) return fail(writeError(error));
  if (data.length === 0) return fail(CANNOT_EDIT);
  const quote = { id: quoteId, dealId: data[0].deal_id, contactId: data[0].contact_id };
  revalidateQuote(orgId, quote);
  redirect(quote.dealId ? paths.deal(orgId, quote.dealId) : quote.contactId ? paths.contact(orgId, quote.contactId) : paths.home);
}

// QUO-02: lines ---------------------------------------------------------------

async function automaticPrice(context: Ctx, orgId: string, pricing: QuotePricing, productId: string, quantity: number) {
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

async function addLine(orgId: string, quoteId: string, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, quoteId);
  if (!context.ok) return context;
  const parsed = quoteLineSchema.safeParse(pick(formData, QUOTE_LINE_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  const input = parsed.data;
  const values = formValues(formData);
  const quote = await readQuote(context.supabase, orgId, quoteId);
  if (!quote) return fail(NOT_FOUND_OR_FORBIDDEN, { values });
  const lines = await readQuoteLines(context.supabase, orgId, quoteId);
  if (lines.length >= QUOTE_LINES_MAX) return fail(TOO_MANY, { values });
  const pricing = await readQuotePricing(context.supabase, orgId, quote);

  let price: { agorot: number; source: "product" | "price_list" | "manual"; listId: string | null };
  // PRD-03: a product line left without a description takes the product's (the form fills it in too)
  let description = input.description;
  if (input.productId) {
    const product = await readPricedProduct(context.supabase, orgId, input.productId);
    if (!product || !product.offerable) return fail(PRODUCT_GONE, { fieldErrors: { product_id: PRODUCT_GONE }, values });
    if (!description && product.description) description = product.description.slice(0, QUOTE_LINE_DESCRIPTION_MAX);
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
  const fieldErrors = checkAmounts(amounts, quote.pricesIncludeVat);
  if (fieldErrors) return fail(Object.values(fieldErrors)[0], { fieldErrors, values });

  const position = lines.reduce((max, line) => Math.max(max, line.position), 0) + 1;
  const { error } = await context.supabase.from("quote_lines").insert({
    organization_id: orgId,
    quote_id: quoteId,
    position: Math.min(position, 100000),
    kind: "item",
    product_id: input.productId,
    name: input.name,
    description,
    quantity: input.quantity,
    unit_price_agorot: price.agorot,
    discount_bp: input.discountBp,
    discount_agorot: input.discountAgorot,
    // a free line's own choices; a product line's come from the product (the trigger overrides them)
    ...(input.productId === null ? { vat_exempt: input.vatExempt ?? false, billing: input.billing ?? "one_time" } : {}),
    is_optional: input.isOptional,
    optional_selected: input.optionalSelected,
    price_source: price.source,
    price_list_id: price.listId,
  });
  if (error) return fail(writeError(error), { values });
  revalidateQuote(orgId, quote);
  return ok(undefined, "השורה נוספה.");
}

/** The price of an edited line follows the deal-line rule (priceOnEdit): typed = theirs, emptied = automatic again. */
async function updateLine(orgId: string, quoteId: string, lineId: string, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, quoteId, lineId);
  if (!context.ok) return context;
  const parsed = quoteLineSchema.safeParse(pick(formData, QUOTE_LINE_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  const input = parsed.data;
  const values = formValues(formData);
  const quote = await readQuote(context.supabase, orgId, quoteId);
  if (!quote) return fail(NOT_FOUND_OR_FORBIDDEN, { values });
  const lines = await readQuoteLines(context.supabase, orgId, quoteId);
  const stored = lines.find((line) => line.id === lineId && line.kind === "item");
  if (!stored) return fail(NOT_FOUND_OR_FORBIDDEN, { values });

  const decision = priceOnEdit(
    { unitPriceAgorot: stored.unitPriceAgorot, quantity: stored.quantity, source: stored.source, hasProduct: stored.productId !== null },
    input.unitPriceAgorot,
    input.quantity,
  );
  let patch = { unit_price_agorot: stored.unitPriceAgorot, price_source: stored.source, price_list_id: stored.priceListId };
  if (decision === "missing") return fail(PRICE_MISSING, { fieldErrors: { unit_price: PRICE_MISSING }, values });
  if (decision === "manual" && input.unitPriceAgorot !== null) {
    patch = { unit_price_agorot: input.unitPriceAgorot, price_source: "manual", price_list_id: null };
  } else if (decision === "pull" && stored.productId) {
    const pricing = await readQuotePricing(context.supabase, orgId, quote);
    const pulled = await automaticPrice(context, orgId, pricing, stored.productId, input.quantity);
    if (!pulled) return fail(PRODUCT_GONE, { values });
    patch = { unit_price_agorot: pulled.priceAgorot, price_source: pulled.source, price_list_id: pulled.priceListId };
  }
  const amounts = { quantity: input.quantity, unitPriceAgorot: patch.unit_price_agorot, discountBp: input.discountBp, discountAgorot: input.discountAgorot };
  const fieldErrors = checkAmounts(amounts, quote.pricesIncludeVat);
  if (fieldErrors) return fail(Object.values(fieldErrors)[0], { fieldErrors, values });

  const sameList = patch.price_source === stored.source && patch.price_list_id === stored.priceListId;
  const { data, error } = await context.supabase
    .from("quote_lines")
    .update({
      name: input.name,
      description: input.description,
      quantity: input.quantity,
      unit_price_agorot: patch.unit_price_agorot,
      discount_bp: input.discountBp,
      discount_agorot: input.discountAgorot,
      ...(stored.productId === null && input.vatExempt !== null ? { vat_exempt: input.vatExempt } : {}),
      ...(stored.productId === null && input.billing !== null ? { billing: input.billing } : {}),
      is_optional: input.isOptional,
      optional_selected: input.optionalSelected,
      ...(sameList ? {} : { price_source: patch.price_source, price_list_id: patch.price_list_id }),
    })
    .eq("organization_id", orgId)
    .eq("quote_id", quoteId)
    .eq("id", lineId)
    .select("id");
  if (error) return fail(writeError(error), { values });
  if (data.length === 0) return fail(CANNOT_EDIT, { values });
  revalidateQuote(orgId, quote);
  return ok(undefined, "השורה עודכנה.");
}

export async function addQuoteLineAction(orgId: string, quoteId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  try {
    return await addLine(orgId, quoteId, formData);
  } catch {
    return fail(dbErrorMessage(null), { values: formValues(formData) });
  }
}

export async function updateQuoteLineAction(orgId: string, quoteId: string, lineId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  try {
    return await updateLine(orgId, quoteId, lineId, formData);
  } catch {
    return fail(dbErrorMessage(null), { values: formValues(formData) });
  }
}

/** QUO-02: a group heading at the end of the quote, or a new title for one. */
export async function saveQuoteGroupAction(orgId: string, quoteId: string, lineId: string | null, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = lineId ? await actionContext(orgId, quoteId, lineId) : await actionContext(orgId, quoteId);
  if (!context.ok) return context;
  const parsed = quoteGroupSchema.safeParse(pick(formData, ["name"]));
  if (!parsed.success) return invalid(parsed.error, formData);
  const values = formValues(formData);
  try {
    const quote = await readQuote(context.supabase, orgId, quoteId);
    if (!quote) return fail(NOT_FOUND_OR_FORBIDDEN, { values });
    if (lineId) {
      const { data, error } = await context.supabase
        .from("quote_lines")
        .update({ name: parsed.data.name })
        .eq("organization_id", orgId)
        .eq("quote_id", quoteId)
        .eq("id", lineId)
        .eq("kind", "group")
        .select("id");
      if (error) return fail(writeError(error), { values });
      if (data.length === 0) return fail(CANNOT_EDIT, { values });
    } else {
      const lines = await readQuoteLines(context.supabase, orgId, quoteId);
      if (lines.length >= QUOTE_LINES_MAX) return fail(TOO_MANY, { values });
      const position = lines.reduce((max, line) => Math.max(max, line.position), 0) + 1;
      const { error } = await context.supabase
        .from("quote_lines")
        .insert({ organization_id: orgId, quote_id: quoteId, kind: "group", name: parsed.data.name, position: Math.min(position, 100000) });
      if (error) return fail(writeError(error), { values });
    }
    revalidateQuote(orgId, quote);
    return ok(undefined, lineId ? "הכותרת עודכנה." : "הקבוצה נוספה.");
  } catch {
    return fail(dbErrorMessage(null), { values });
  }
}

export async function deleteQuoteLineAction(orgId: string, quoteId: string, lineId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, quoteId, lineId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("quote_lines")
    .delete()
    .eq("organization_id", orgId)
    .eq("quote_id", quoteId)
    .eq("id", lineId)
    .select("id");
  if (error) return fail(writeError(error));
  if (data.length === 0) return fail(CANNOT_EDIT);
  // the quote's total changed: the deal and contact cards show it
  const { data: parent, error: parentError } = await context.supabase.from("quotes").select("deal_id, contact_id").eq("organization_id", orgId).eq("id", quoteId).maybeSingle();
  // the line is gone either way; without the parents only the quote page is refreshed
  if (parentError) {
    revalidatePath(quotePath(orgId, quoteId));
    return ok();
  }
  revalidateQuote(orgId, { id: quoteId, dealId: parent?.deal_id ?? null, contactId: parent?.contact_id ?? null });
  return ok();
}

const orderArg = z.array(z.guid()).min(1).max(QUOTE_LINES_MAX);

/** QUO-02: the lines in the order a drag (or the move buttons) left them, saved in one call. */
export async function reorderQuoteLinesAction(orgId: string, quoteId: string, ids: unknown): Promise<ActionResult> {
  if (!validArg(orderArg, ids) || new Set(ids).size !== ids.length) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, quoteId);
  if (!context.ok) return context;
  const { error } = await context.supabase.rpc("quote_lines_reorder", { p_org: orgId, p_quote: quoteId, p_ids: ids });
  if (error) return fail(writeError(error));
  revalidatePath(quotePath(orgId, quoteId));
  return ok();
}

// QUO-07 ---------------------------------------------------------------------

export type SentQuote = {
  // the customer's new link, shown once (null = not asked for, or it could not be made)
  url: string | null;
  // the quote was sent but its link could not be made; the link card offers it again
  linkError: string | null;
  // the running number the quote got
  numberDisplay: string | null;
};

/**
 * Marks a draft as sent (public.quote_send): it gets its running number, the customer names are kept as they are now,
 * and it is locked. QUO-08 (owner, 18 October 2026): with `withLink` it also makes the customer's link right away, so the
 * WhatsApp and email buttons are offered at the moment of sending. The two are separate calls: a failed link never undoes
 * the sending, and is reported beside it.
 */
export async function sendQuoteAction(orgId: string, quoteId: string, withLink: unknown = false): Promise<ActionResult<SentQuote>> {
  if (typeof withLink !== "boolean") return fail(INVALID_ARGS);
  const context = await actionContext(orgId, quoteId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("quote_send", { p_org: orgId, p_quote: quoteId });
  if (error) return fail(writeError(error));
  const number = (data as { number?: unknown } | null)?.number;
  const sent: SentQuote = { url: null, linkError: null, numberDisplay: typeof number === "string" ? number : null };
  if (withLink) {
    const link = await context.supabase.rpc("quote_link_create", { p_org: orgId, p_quote: quoteId });
    if (link.error) sent.linkError = writeError(link.error);
    else if (typeof link.data !== "string" || !QUOTE_LINK_TOKEN.test(link.data)) sent.linkError = "לא הצלחנו ליצור קישור. נסו שוב.";
    else sent.url = `${await siteOrigin()}${publicQuotePath(link.data)}`;
  }
  const quote = await readQuote(context.supabase, orgId, quoteId);
  if (quote) revalidateQuote(orgId, quote);
  else revalidatePath(quotePath(orgId, quoteId));
  return ok(sent);
}

// QUO-12 ---------------------------------------------------------------------

const VERSION_PRODUCT_GONE =
  "באחת השורות יש מוצר שכבר לא פעיל או נמצא בארכיון, ולכן אי אפשר להעתיק את ההצעה. החזירו את המוצר לפעיל, או צרו הצעה חדשה.";

/**
 * Editing a sent quote (owner, 18 October 2026): public.quote_new_version makes a draft copy of it, its lines and its
 * payment steps, linked as its newer version; the sent quote itself never changes. Opens the new draft.
 */
export async function newQuoteVersionAction(orgId: string, quoteId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, quoteId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("quote_new_version", { p_org: orgId, p_quote: quoteId });
  if (error?.hint === "quote_lines:product") return fail(VERSION_PRODUCT_GONE);
  if (error) return fail(writeError(error));
  if (typeof data !== "string") return fail("לא הצלחנו ליצור גרסה חדשה. נסו שוב.");
  const quote = await readQuote(context.supabase, orgId, quoteId);
  if (quote) revalidateQuote(orgId, quote);
  redirect(quotePath(orgId, data));
}

/**
 * QUO-11: cancels a sent, viewed or expired quote (public.quote_cancel; whoever may edit its deal or contact). The customer's
 * page closes with it, and the timeline of the deal and the contact says who cancelled.
 */
export async function cancelQuoteAction(orgId: string, quoteId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, quoteId);
  if (!context.ok) return context;
  const { error } = await context.supabase.rpc("quote_cancel", { p_org: orgId, p_quote: quoteId });
  if (error) return fail(writeError(error));
  const quote = await readQuote(context.supabase, orgId, quoteId);
  if (quote) revalidateQuote(orgId, quote);
  return ok();
}

/** GAP-10: an empty draft that adds to an accepted quote (public.quote_new_addendum); opens it. */
export async function newQuoteAddendumAction(orgId: string, quoteId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, quoteId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("quote_new_addendum", { p_org: orgId, p_quote: quoteId });
  if (error) return fail(writeError(error));
  if (typeof data !== "string") return fail("לא הצלחנו ליצור תוספת. נסו שוב.");
  const quote = await readQuote(context.supabase, orgId, quoteId);
  if (quote) revalidateQuote(orgId, quote);
  redirect(quotePath(orgId, data));
}

/**
 * QUO-08: a new link for the customer to a sent quote (public.quote_link_create). The address is returned once: only
 * its hash is kept, and the previous link of the quote stops working.
 */
export async function createQuoteLinkAction(orgId: string, quoteId: string): Promise<ActionResult<{ url: string }>> {
  const context = await actionContext(orgId, quoteId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("quote_link_create", { p_org: orgId, p_quote: quoteId });
  if (error) return fail(writeError(error));
  if (typeof data !== "string" || !QUOTE_LINK_TOKEN.test(data)) return fail("לא הצלחנו ליצור קישור. נסו שוב.");
  revalidatePath(quotePath(orgId, quoteId));
  return ok({ url: `${await siteOrigin()}${publicQuotePath(data)}` });
}

/** QUO-08: turns the customer's link off; the page answers "not found" from now on. */
export async function revokeQuoteLinkAction(orgId: string, quoteId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, quoteId);
  if (!context.ok) return context;
  const { error } = await context.supabase.rpc("quote_link_revoke", { p_org: orgId, p_quote: quoteId });
  if (error) return fail(writeError(error));
  revalidatePath(quotePath(orgId, quoteId));
  return ok();
}
