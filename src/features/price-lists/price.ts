import type { ProductPrice } from "@/features/products/price";

import { priceListApplies, type PriceListTerms } from "./status";

/**
 * The unit price of a product from a price list (PL-01, PL-02).
 *
 * The default price list is the product's own price. A further list applies
 * only while it is active and the day ("YYYY-MM-DD", the organization's time
 * zone) is within its dates (priceListApplies). Within it, the product's lines
 * are quantity tiers: the line with the largest min_quantity not above the
 * quantity wins. No list, a list that does not apply, or no fitting line: the
 * product's own price.
 *
 * A line is either
 *   - a fixed price, typed with its own mode (price_includes_vat), exactly like
 *     a product's price (TAX-04); or
 *   - a discount in basis points off the product's own price, which keeps the
 *     product's mode: price x (10000 - bp) / 10000, half up to the agora,
 *     exact (BigInt), like productPriceFor() and app.document_totals().
 *
 * The answer has the shape of a product's price, so a document line takes it
 * into its own mode with productPriceFor(result, documentIncludesVat, rateBp).
 * "Including VAT" is only meaningful for a taxable product; for another one
 * the answer says false (its price is its net), as productPriceFor() reads it.
 *
 * Quantities and minimums are compared in thousandths, the precision of
 * price_list_lines.min_quantity (numeric(12,3)).
 */

export type PriceListLineRule = {
  id: string;
  productId: string;
  minQuantity: number;
  // exactly one of these two is set (price_list_lines_one_rule)
  priceAgorot: number | null;
  discountBp: number | null;
  priceIncludesVat: boolean;
};

export type PricedProduct = ProductPrice & { id: string };

export type PriceListForPricing = PriceListTerms & { lines: readonly PriceListLineRule[] };

export type UnitPriceSource = "product" | "list_price" | "list_discount";

export type UnitPrice = {
  priceAgorot: number;
  priceIncludesVat: boolean;
  source: UnitPriceSource;
  // the price list line that set the price, null for the product's own price
  lineId: string | null;
};

const TWO = BigInt(2);
const BASIS = BigInt(10000);

function thousandths(value: number): number {
  return Math.round(value * 1000);
}

/** price x (10000 - bp) / 10000, rounded half up to the agora. */
export function discountedPrice(priceAgorot: number, discountBp: number): number {
  if (!Number.isSafeInteger(priceAgorot) || priceAgorot < 0) throw new RangeError("price");
  if (!Number.isInteger(discountBp) || discountBp < 0 || discountBp > 10000) throw new RangeError("discount");
  const numerator = BigInt(priceAgorot) * (BASIS - BigInt(discountBp));
  return Number((numerator * TWO + BASIS) / (BASIS * TWO));
}

/** The line of the product that fits the quantity: the largest minimum not above it, or null. */
export function tierFor(lines: readonly PriceListLineRule[], productId: string, quantity: number): PriceListLineRule | null {
  const wanted = thousandths(quantity);
  let best: PriceListLineRule | null = null;
  for (const line of lines) {
    if (line.productId !== productId) continue;
    const min = thousandths(line.minQuantity);
    if (min > wanted) continue;
    if (best === null || min > thousandths(best.minQuantity)) best = line;
  }
  return best;
}

export function unitPriceFor(product: PricedProduct, list: PriceListForPricing | null, quantity: number, day: string): UnitPrice {
  if (!Number.isFinite(quantity) || quantity < 0) throw new RangeError("quantity");
  const taxable = product.vatKind === "taxable";
  const own: UnitPrice = { priceAgorot: product.priceAgorot, priceIncludesVat: taxable && product.priceIncludesVat, source: "product", lineId: null };
  if (list === null || !priceListApplies(list, day)) return own;
  const line = tierFor(list.lines, product.id, quantity);
  if (line === null) return own;
  if (line.priceAgorot !== null) {
    return { priceAgorot: line.priceAgorot, priceIncludesVat: taxable && line.priceIncludesVat, source: "list_price", lineId: line.id };
  }
  if (line.discountBp !== null) {
    return { priceAgorot: discountedPrice(product.priceAgorot, line.discountBp), priceIncludesVat: own.priceIncludesVat, source: "list_discount", lineId: line.id };
  }
  return own;
}
