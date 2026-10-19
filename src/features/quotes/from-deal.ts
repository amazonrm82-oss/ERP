// DLI-05 part one: a new quote made from its deal's product lines. The pure plan (no database), unit tested.
//
// Every line is copied as it is on the deal (owner's rule for orders from a deal, 19 October 2026, applied to quotes):
// quantity, unit price, line discount, and for a free line its billing and VAT exemption; a product line's billing and
// VAT come from its product (the database sets them). The deal line's text becomes the quote line's name (cut to 300
// characters, trimmed); a product line also takes the product's description (PRD-03). A product that is no longer
// offered (inactive or archived) cannot go on a quote: its line is left out and named.

import type { DealLine } from "@/features/deal-lines/queries";
import type { Billing } from "@/features/products/schema";

import { QUOTE_LINE_DESCRIPTION_MAX, QUOTE_LINE_NAME_MAX } from "./schema";

export type DealLineCopy = {
  position: number;
  productId: string | null;
  name: string;
  description: string | null;
  quantity: number;
  unitPriceAgorot: number;
  discountBp: number | null;
  discountAgorot: number | null;
  // a free line's own choices; null on a product line (its product's)
  vatExempt: boolean | null;
  billing: Billing | null;
  priceSource: "product" | "price_list" | "manual";
  priceListId: string | null;
};

export type DealLinesPlan = { lines: DealLineCopy[]; skipped: string[] };

/** A line's name from the deal line's text: trimmed, at most 300 characters (code points), never empty. */
export function lineName(text: string, fallback: string | null = null): string {
  const cut = Array.from(text.trim()).slice(0, QUOTE_LINE_NAME_MAX).join("").trim();
  if (cut !== "") return cut;
  const other = Array.from((fallback ?? "").trim()).slice(0, QUOTE_LINE_NAME_MAX).join("").trim();
  return other !== "" ? other : "שורה";
}

export function planDealLines(
  lines: readonly DealLine[],
  start: number,
  product: (id: string) => { offerable: boolean; name: string; description: string | null } | null,
): DealLinesPlan {
  const out: DealLineCopy[] = [];
  const skipped: string[] = [];
  for (const line of lines) {
    const found = line.productId ? product(line.productId) : null;
    if (line.productId && (!found || !found.offerable)) {
      skipped.push(lineName(line.description, found?.name ?? null));
      continue;
    }
    const isProduct = line.productId !== null;
    // a price list's price names its list; a list that was deleted leaves the price as typed
    const priceSource = line.source === "price_list" ? (line.priceListId ? "price_list" : "manual") : line.source === "product" && isProduct ? "product" : "manual";
    out.push({
      position: start + out.length,
      productId: line.productId,
      name: lineName(line.description, found?.name ?? null),
      description: isProduct && found?.description ? Array.from(found.description).slice(0, QUOTE_LINE_DESCRIPTION_MAX).join("") : null,
      quantity: line.quantity,
      unitPriceAgorot: line.unitPriceAgorot,
      discountBp: line.discountBp,
      discountAgorot: line.discountAgorot,
      vatExempt: isProduct ? null : line.vatExempt,
      billing: isProduct ? null : (line.billing ?? "one_time"),
      priceSource,
      priceListId: priceSource === "price_list" ? line.priceListId : null,
    });
  }
  return { lines: out, skipped };
}

/** The notice on the new quote: "נוספו 3 שורות מהעסקה." plus what was left out. */
export function fromDealText(added: number, skipped: number): string {
  const head = added === 1 ? "נוספה שורה אחת מהעסקה" : `נוספו ${added} שורות מהעסקה`;
  if (skipped === 0) return `${head}.`;
  return skipped === 1
    ? `${head}. שורה אחת לא הועתקה, כי המוצר שלה כבר לא פעיל. אפשר להוסיף אותה כשורה חופשית.`
    : `${head}. ${skipped} שורות לא הועתקו, כי המוצרים שלהן כבר לא פעילים. אפשר להוסיף אותן כשורות חופשיות.`;
}
