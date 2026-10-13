/**
 * A product's price on a document line (PRD-01, TAX-04).
 *
 * public.products keeps the price exactly as typed (price_agorot) and the mode
 * it was typed in (price_includes_vat). A document line is typed in the
 * document's own mode, so the product's price is carried over:
 *   - the same number when the modes agree, or the product carries no VAT
 *     (exempt or zero rate: its price is its net), or the rate is 0 (a
 *     business that charges no VAT, TAX-01);
 *   - net -> including VAT: price x (10000 + rate) / 10000;
 *   - including VAT -> net: price x 10000 / (10000 + rate);
 * rounded half up to the agora, exact (BigInt), like app.document_totals().
 * rateBp is the document's rate in basis points (documentVatRateBp()).
 */
export type ProductPrice = {
  priceAgorot: number;
  priceIncludesVat: boolean;
  vatKind: "taxable" | "exempt" | "zero_rate";
};

const TWO = BigInt(2);
const BASIS = BigInt(10000);

function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * TWO + denominator) / (denominator * TWO);
}

export function productPriceFor(product: ProductPrice, documentIncludesVat: boolean, rateBp: number): number {
  if (!Number.isSafeInteger(product.priceAgorot) || product.priceAgorot < 0) throw new RangeError("price");
  if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > 10000) throw new RangeError("rate");
  const typedIncludesVat = product.vatKind === "taxable" && product.priceIncludesVat;
  const lineIncludesVat = product.vatKind === "taxable" && documentIncludesVat;
  if (typedIncludesVat === lineIncludesVat || rateBp === 0) return product.priceAgorot;
  const price = BigInt(product.priceAgorot);
  const rate = BigInt(rateBp);
  const result = lineIncludesVat ? divideHalfUp(price * (BASIS + rate), BASIS) : divideHalfUp(price * BASIS, BASIS + rate);
  return Number(result);
}
