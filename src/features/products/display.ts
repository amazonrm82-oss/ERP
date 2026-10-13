import { formatMoney } from "@/lib/format";

import { BILLING_LABELS, type Billing, type VatKind } from "./schema";

/** "₪1,250 לפני מע"מ", "₪1,475 כולל מע"מ", or the bare price of a product without VAT. */
export function productPriceText(product: { priceAgorot: number; priceIncludesVat: boolean; vatKind: VatKind }): string {
  const price = formatMoney(product.priceAgorot);
  if (product.vatKind !== "taxable") return price;
  return `${price} ${product.priceIncludesVat ? 'כולל מע"מ' : 'לפני מע"מ'}`;
}

/** "חודשי" next to a price that repeats; nothing for a one-time price. */
export function billingSuffix(billing: Billing): string | null {
  return billing === "one_time" ? null : BILLING_LABELS[billing];
}
