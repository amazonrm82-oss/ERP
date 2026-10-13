import { productPriceFor } from "@/features/products/price";
import type { VatKind } from "@/features/products/schema";
import { formatMoney, formatNumber } from "@/lib/format";

import type { UnitPrice } from "./price";

/** "כל כמות" for a tier from 0, else "מכמות 10". */
export function tierText(minQuantity: number): string {
  return minQuantity === 0 ? "כל כמות" : `מכמות ${formatNumber(minQuantity)}`;
}

/** "10%" or "12.5%" from basis points. */
export function percentText(bp: number): string {
  return `${formatNumber(bp / 100)}%`;
}

/** "₪90 לפני מע"מ", "₪106.20 כולל מע"מ", or the bare amount for a product without VAT. */
export function unitPriceText(price: Pick<UnitPrice, "priceAgorot" | "priceIncludesVat">, vatKind: VatKind): string {
  const amount = formatMoney(price.priceAgorot);
  if (vatKind !== "taxable") return amount;
  return `${amount} ${price.priceIncludesVat ? 'כולל מע"מ' : 'לפני מע"מ'}`;
}

/** "85" from 8500 agorot, for a price input. */
export function priceInput(agorot: number): string {
  return agorot % 100 === 0 ? String(agorot / 100) : (agorot / 100).toFixed(2);
}

/**
 * A discount line's resulting price, shown in the list's VAT mode (owner, 13 October 2026: every price
 * in a list is shown by the list's setting). Display only: the line stores the discount, and a document
 * converts the price at its own rate (unitPriceFor + productPriceFor). rateBp is today's rate from
 * documentVatRateBp(): 0 for a business that charges no VAT, null when the status or the rate is not
 * known; then, and for a product without VAT, the price is shown as is, with its own mode.
 */
export function discountPriceShown(
  price: Pick<UnitPrice, "priceAgorot" | "priceIncludesVat">,
  vatKind: VatKind,
  listIncludesVat: boolean,
  rateBp: number | null,
): Pick<UnitPrice, "priceAgorot" | "priceIncludesVat"> {
  if (vatKind !== "taxable" || rateBp === null || rateBp === 0) return price;
  return { priceAgorot: productPriceFor({ ...price, vatKind }, listIncludesVat, rateBp), priceIncludesVat: listIncludesVat };
}
