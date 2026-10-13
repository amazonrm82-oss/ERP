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
