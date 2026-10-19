import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { readDealLines, readPricedProduct } from "@/features/deal-lines/queries";
import type { Database } from "@/lib/database.types";
import { dbErrorMessage } from "@/lib/errors";

import { planDealLines } from "./from-deal";
import { readQuoteLines, type Quote } from "./queries";

type Client = SupabaseClient<Database>;

export type FromDealResult = { ok: true; added: number; skipped: number } | { ok: false; message: string };

const CANNOT_EDIT = "אי אפשר לשנות את ההצעה. ייתכן שהיא כבר לא טיוטה, או שאין לכם הרשאה לערוך אותה.";
const MODE_CLASH = 'בהצעה כבר יש שורות שהמחירים בהן כתובים באופן אחר (כולל מע"מ או לפני מע"מ). אפשר להעתיק את שורות העסקה להצעה ריקה.';

/**
 * DLI-05 part one: copies the lines of the quote's deal into the draft, with the user's session (RLS and the line triggers
 * decide). A quote with no item lines yet takes the deal's VAT mode first. The lines go in one insert, so a refusal (the
 * plan, a discount flag) adds none of them.
 */
export async function applyDealLinesToQuote(supabase: Client, orgId: string, quote: Quote): Promise<FromDealResult> {
  if (quote.status !== "draft" || quote.dealId === null) return { ok: false, message: CANNOT_EDIT };
  const [dealLines, existing] = await Promise.all([readDealLines(supabase, orgId, quote.dealId), readQuoteLines(supabase, orgId, quote.id)]);
  if (dealLines.length === 0) return { ok: true, added: 0, skipped: 0 };

  // the deal's one VAT mode (DLI-01)
  const mode = dealLines[0].priceIncludesVat;
  if (mode !== quote.pricesIncludeVat) {
    if (existing.some((line) => line.kind === "item")) return { ok: false, message: MODE_CLASH };
    const { data, error } = await supabase.from("quotes").update({ prices_include_vat: mode }).eq("organization_id", orgId).eq("id", quote.id).select("id");
    if (error) return { ok: false, message: error.code === "42501" ? CANNOT_EDIT : dbErrorMessage(error) };
    if (data.length === 0) return { ok: false, message: CANNOT_EDIT };
  }

  const productIds = [...new Set(dealLines.map((line) => line.productId).filter((id): id is string => id !== null))];
  const products = new Map(
    (await Promise.all(productIds.map((id) => readPricedProduct(supabase, orgId, id)))).filter((p) => p !== null).map((p) => [p.id, p]),
  );
  const start = existing.reduce((max, line) => Math.max(max, line.position), 0) + 1;
  const plan = planDealLines(dealLines, start, (id) => {
    const p = products.get(id);
    return p ? { offerable: p.offerable, name: p.name, description: p.description } : null;
  });

  if (plan.lines.length > 0) {
    const { error } = await supabase.from("quote_lines").insert(
      plan.lines.map((line) => ({
        organization_id: orgId,
        quote_id: quote.id,
        position: Math.min(line.position, 100000),
        kind: "item",
        product_id: line.productId,
        name: line.name,
        description: line.description,
        quantity: line.quantity,
        unit_price_agorot: line.unitPriceAgorot,
        discount_bp: line.discountBp,
        discount_agorot: line.discountAgorot,
        // a product line's VAT and billing come from its product (trigger quote_lines_check)
        ...(line.productId === null ? { vat_exempt: line.vatExempt ?? false, billing: line.billing ?? "one_time" } : {}),
        price_source: line.priceSource,
        price_list_id: line.priceListId,
      })),
    );
    if (error) return { ok: false, message: error.code === "42501" ? CANNOT_EDIT : dbErrorMessage(error) };
  }
  return { ok: true, added: plan.lines.length, skipped: plan.skipped.length };
}
