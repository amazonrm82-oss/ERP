import type { Billing } from "@/features/products/schema";

/**
 * QUO-04: a quote template is a saved quote: its lines (items from the catalog or free, group
 * headings, optional lines), notes and terms. Using it adds its lines to a draft quote. A product
 * line saved without a price takes the automatic price for this quote's customer (PL-03); a typed
 * price is kept as typed. A product that is no longer offered is skipped and counted.
 */

export const QUOTE_TEMPLATE_NAME_MAX = 120;
// app.quote_template_lines_check / app.quote_lines_check
export const QUOTE_TEMPLATE_LINES_MAX = 200;

export type QuoteTemplateLine = {
  kind: "item" | "group";
  productId: string | null;
  name: string;
  description: string | null;
  quantity: number;
  // null on a product line = the automatic price when used
  unitPriceAgorot: number | null;
  discountBp: number | null;
  discountAgorot: number | null;
  vatExempt: boolean;
  billing: Billing;
  isOptional: boolean;
  optionalSelected: boolean;
};

export type PlannedPrice = { agorot: number; source: "product" | "price_list" | "manual"; listId: string | null };

export type PlannedLine = Omit<QuoteTemplateLine, "unitPriceAgorot"> & { position: number; price: PlannedPrice };

/**
 * The quote lines a template adds, in its order, after the quote's last position.
 * `offerable(productId)` says whether a product may still be offered; `automatic(productId, quantity)`
 * gives its automatic price for this quote (null when it cannot be priced).
 */
export function planTemplateLines(
  lines: readonly QuoteTemplateLine[],
  startPosition: number,
  offerable: (productId: string) => boolean,
  automatic: (productId: string, quantity: number) => PlannedPrice | null,
): { lines: PlannedLine[]; skipped: number } {
  const planned: PlannedLine[] = [];
  let skipped = 0;
  for (const line of lines) {
    const { unitPriceAgorot, ...rest } = line;
    const position = Math.min(startPosition + planned.length, 100000);
    if (line.kind === "group") {
      planned.push({ ...rest, position, price: { agorot: 0, source: "manual", listId: null } });
      continue;
    }
    if (line.productId !== null) {
      if (!offerable(line.productId)) {
        skipped += 1;
        continue;
      }
      const price: PlannedPrice | null =
        unitPriceAgorot === null ? automatic(line.productId, line.quantity) : { agorot: unitPriceAgorot, source: "manual", listId: null };
      if (price === null) {
        skipped += 1;
        continue;
      }
      planned.push({ ...rest, position, price });
      continue;
    }
    if (unitPriceAgorot === null) {
      skipped += 1;
      continue;
    }
    planned.push({ ...rest, position, price: { agorot: unitPriceAgorot, source: "manual", listId: null } });
  }
  return { lines: planned, skipped };
}

/** "נוספו 5 שורות מהתבנית" / "…, ושורה אחת דולגה כי המוצר כבר לא פעיל". */
export function appliedText(added: number, skipped: number): string {
  const head = added === 1 ? "נוספה שורה אחת מהתבנית" : `נוספו ${added} שורות מהתבנית`;
  if (skipped === 0) return `${head}.`;
  return skipped === 1
    ? `${head}. שורה אחת דולגה, כי המוצר שלה כבר לא פעיל.`
    : `${head}. ${skipped} שורות דולגו, כי המוצרים שלהן כבר לא פעילים.`;
}
