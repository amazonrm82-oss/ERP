import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { priceListTiers, readPricedProduct, type PickedProduct } from "@/features/deal-lines/queries";
import { pulledPrice } from "@/features/deal-lines/pricing";
import { isBilling } from "@/features/deal-lines/recurring";
import type { Database } from "@/lib/database.types";
import { must } from "@/lib/db-read";
import { dbErrorMessage } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";

import { readQuoteLines, readQuotePricing, type Quote } from "./queries";
import { planTemplateLines, QUOTE_TEMPLATE_LINES_MAX, type QuoteTemplateLine } from "./templates";

type Client = SupabaseClient<Database>;

export type QuoteTemplateSummary = { id: string; name: string; notes: string | null; createdAt: string };

/** QUO-04: the business's quote templates by name (every member reads them; at most 200 by the plan). */
export async function listQuoteTemplates(orgId: string): Promise<QuoteTemplateSummary[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase.from("quote_templates").select("id, name, notes, created_at").eq("organization_id", orgId).order("name").order("id").limit(1000),
    "quote templates",
  );
  return rows.map((t) => ({ id: t.id, name: t.name, notes: t.notes, createdAt: t.created_at }));
}

async function readTemplateLines(supabase: Client, orgId: string, templateId: string): Promise<QuoteTemplateLine[]> {
  const rows = must(
    await supabase
      .from("quote_template_lines")
      .select("kind, product_id, name, description, quantity, unit_price_agorot, discount_bp, discount_agorot, vat_exempt, billing, is_optional, optional_selected")
      .eq("organization_id", orgId)
      .eq("template_id", templateId)
      .order("position")
      .order("created_at")
      .order("id"),
    "quote template lines",
  );
  return rows.map((row) => ({
    kind: row.kind === "group" ? "group" : "item",
    productId: row.product_id,
    name: row.name,
    description: row.description,
    quantity: Number(row.quantity),
    unitPriceAgorot: row.unit_price_agorot === null ? null : Number(row.unit_price_agorot),
    discountBp: row.discount_bp,
    discountAgorot: row.discount_agorot === null ? null : Number(row.discount_agorot),
    vatExempt: row.vat_exempt,
    billing: isBilling(row.billing) ? row.billing : "one_time",
    isOptional: row.is_optional,
    optionalSelected: row.optional_selected,
  }));
}

export type ApplyResult = { ok: true; added: number; skipped: number } | { ok: false; message: string };

const MODE_CLASH = 'המחירים בתבנית ובהצעה כתובים באופן שונה (כולל מע"מ או לפני מע"מ). אפשר להוסיף את התבנית להצעה ריקה, או להצעה באותו אופן.';
const NO_VAT_CLASH = 'בתבנית המחירים כוללים מע"מ, וההצעה היא בלי מע"מ. בטלו את "הצעה זו בלי מע"מ" ונסו שוב.';
const TOO_MANY = `אחרי הוספת התבנית יהיו בהצעה יותר מ-${QUOTE_TEMPLATE_LINES_MAX} שורות. מחקו שורות או בחרו תבנית קטנה יותר.`;
const NOT_FOUND = "התבנית לא נמצאה. ייתכן שנמחקה.";
const CANNOT_EDIT = "אי אפשר לשנות את ההצעה. ייתכן שהיא כבר לא טיוטה, או שאין לכם הרשאה לערוך אותה.";

/**
 * QUO-04: adds a template's lines to a draft quote, with the user's session (RLS decides). A quote with
 * no item lines yet takes the template's VAT mode first; notes and terms fill only empty ones. The new
 * lines go in one insert, so a refusal (the plan, a discount flag) adds none of them.
 */
export async function applyTemplateToQuote(supabase: Client, orgId: string, quote: Quote, templateId: string): Promise<ApplyResult> {
  if (quote.status !== "draft") return { ok: false, message: CANNOT_EDIT };
  const { data: template, error: templateError } = await supabase
    .from("quote_templates")
    .select("id, notes, terms, prices_include_vat")
    .eq("organization_id", orgId)
    .eq("id", templateId)
    .maybeSingle();
  if (templateError) return { ok: false, message: dbErrorMessage(templateError) };
  if (!template) return { ok: false, message: NOT_FOUND };
  const [templateLines, existing] = await Promise.all([readTemplateLines(supabase, orgId, templateId), readQuoteLines(supabase, orgId, quote.id)]);
  if (existing.length + templateLines.length > QUOTE_TEMPLATE_LINES_MAX) return { ok: false, message: TOO_MANY };

  let current = quote;
  const templateHasItems = templateLines.some((line) => line.kind === "item");
  if (templateHasItems && template.prices_include_vat !== quote.pricesIncludeVat) {
    if (existing.some((line) => line.kind === "item")) return { ok: false, message: MODE_CLASH };
    if (template.prices_include_vat && quote.noVatReason !== null) return { ok: false, message: NO_VAT_CLASH };
    const { data, error } = await supabase
      .from("quotes")
      .update({ prices_include_vat: template.prices_include_vat })
      .eq("organization_id", orgId)
      .eq("id", quote.id)
      .select("id");
    if (error) return { ok: false, message: error.code === "42501" ? CANNOT_EDIT : dbErrorMessage(error) };
    if (data.length === 0) return { ok: false, message: CANNOT_EDIT };
    current = { ...quote, pricesIncludeVat: template.prices_include_vat };
  }

  const pricing = await readQuotePricing(supabase, orgId, current);
  const productIds = [...new Set(templateLines.map((line) => line.productId).filter((id): id is string => id !== null))];
  const [products, tiers] = await Promise.all([
    Promise.all(productIds.map((id) => readPricedProduct(supabase, orgId, id))),
    pricing.list ? priceListTiers(supabase, orgId, pricing.list.id, productIds) : Promise.resolve([]),
  ]);
  const byId = new Map(products.filter((p): p is PickedProduct => p !== null).map((p) => [p.id, p]));
  const start = existing.reduce((max, line) => Math.max(max, line.position), 0) + 1;
  const plan = planTemplateLines(
    templateLines,
    start,
    (id) => byId.get(id)?.offerable === true,
    (id, quantity) => {
      const product = byId.get(id);
      if (!product) return null;
      const list = pricing.list ? { ...pricing.list, lines: tiers.filter((tier) => tier.productId === id) } : null;
      const pulled = pulledPrice(product, list, quantity, pricing.day, pricing.includesVat, pricing.rateBp);
      return { agorot: pulled.priceAgorot, source: pulled.source, listId: pulled.priceListId };
    },
  );

  if (plan.lines.length > 0) {
    const { error } = await supabase.from("quote_lines").insert(
      plan.lines.map((line) => ({
        organization_id: orgId,
        quote_id: quote.id,
        position: line.position,
        kind: line.kind,
        product_id: line.productId,
        name: line.name,
        description: line.description,
        quantity: line.quantity,
        unit_price_agorot: line.price.agorot,
        discount_bp: line.discountBp,
        discount_agorot: line.discountAgorot,
        // a product line's VAT and billing come from its product (trigger quote_lines_check)
        ...(line.productId === null && line.kind === "item" ? { vat_exempt: line.vatExempt, billing: line.billing } : {}),
        is_optional: line.isOptional,
        optional_selected: line.optionalSelected,
        price_source: line.price.source,
        price_list_id: line.price.listId,
      })),
    );
    if (error) return { ok: false, message: error.code === "42501" ? CANNOT_EDIT : dbErrorMessage(error) };
  }

  const fill = {
    ...(current.notes === null && template.notes ? { notes: template.notes } : {}),
    ...(current.terms === null && template.terms ? { terms: template.terms } : {}),
  };
  if (Object.keys(fill).length > 0) {
    const { error } = await supabase.from("quotes").update(fill).eq("organization_id", orgId).eq("id", quote.id).select("id");
    if (error) return { ok: false, message: dbErrorMessage(error) };
  }
  return { ok: true, added: plan.lines.filter((line) => line.kind === "item").length, skipped: plan.skipped };
}
