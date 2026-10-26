import { z } from "zod";

import { pulledPrice, type NamedPriceList } from "@/features/deal-lines/pricing";
import type { PaymentMethod } from "@/features/payments/schema";
import type { PricedProduct } from "@/features/price-lists/price";
import type { Billing } from "@/features/products/schema";
import { documentTotals, type DocumentTotals, type TotalsError } from "@/features/tax/calc";

/**
 * GAP-08: the quick sale at the counter. Pure: the prices and the total the screen shows are the ones the
 * server sends to public.quick_sale (migration quick_sale), which recomputes the total from the stored lines
 * and refuses a different one (hint quick_sale:total_changed).
 *
 * - Each item is an offerable one-time product (a counter sale is one charge; the database refuses a recurring
 *   product, hint quick_sale:recurring), priced as a deal line is priced (PL-03: the customer's price list, else
 *   the product's price, carried into the business's VAT mode; pulledPrice()).
 * - The amount paid is the document total WITH VAT at the day's document rate (documentTotals()).
 * - PKG-01 (wave 3): a punch-card product will be one more kind of item here.
 */

export const QUICK_SALE_MAX_ITEMS = 50;
export const QUICK_SALE_DOC_TYPES = ["tax_invoice_receipt", "receipt"] as const;
export type QuickSaleDocType = (typeof QUICK_SALE_DOC_TYPES)[number];
/** A cheque at the counter is in hand or already cleared (deposited and bounced belong to its later life on the card). */
export const QUICK_SALE_CHEQUE_STATUSES = ["in_hand", "cleared"] as const;

/**
 * The deal's name: the business's word for a deal, "מכירה מהירה" and the day; never the customer's name, so a privacy
 * erasure (PRV-03) has no deal to rename. day is YYYY-MM-DD in the business's zone.
 */
export function quickSaleDealName(dealWord: string, day: string): string {
  const [y, m, d] = day.split("-");
  return `${dealWord} ממכירה מהירה, ${d}.${m}.${y}`.slice(0, 200);
}

export const quickSaleItemsSchema = z
  .array(
    z.object({
      productId: z.guid(),
      quantity: z
        .number()
        .positive()
        .max(1_000_000)
        .refine((n) => Math.round(n * 1000) === n * 1000),
    }),
  )
  .min(1)
  .max(QUICK_SALE_MAX_ITEMS);
export type QuickSaleItem = z.infer<typeof quickSaleItemsSchema>[number];

export type SaleProduct = PricedProduct & { name: string; billing: Billing; offerable: boolean };

export type PricedLine = {
  productId: string;
  name: string;
  quantity: number;
  unitPriceAgorot: number;
  source: "product" | "price_list";
  priceListId: string | null;
  vatExempt: boolean;
};

export type SalePricing = {
  day: string;
  /** the business's VAT mode for prices (TAX-04) */
  includesVat: boolean;
  /** carries a product price between the VAT modes (conversionRateBp) */
  conversionRateBp: number;
  /** the document rate of the day; null = the VAT status is not set */
  documentRateBp: number | null;
  list: NamedPriceList | null;
};

export type PricedSale =
  | { ok: true; lines: PricedLine[]; totals: DocumentTotals }
  | { ok: false; reason: "product" | "recurring" | "vat_unknown"; productId?: string }
  | { ok: false; reason: "totals"; error: TotalsError };

/** The lines and totals of a sale, or why it cannot be priced. Items of the same product stay separate lines. */
export function priceSale(items: readonly QuickSaleItem[], products: ReadonlyMap<string, SaleProduct>, pricing: SalePricing): PricedSale {
  if (pricing.documentRateBp === null) return { ok: false, reason: "vat_unknown" };
  const lines: PricedLine[] = [];
  for (const item of items) {
    const product = products.get(item.productId);
    if (!product || !product.offerable) return { ok: false, reason: "product", productId: item.productId };
    if (product.billing !== "one_time") return { ok: false, reason: "recurring", productId: item.productId };
    const price = pulledPrice(product, pricing.list, item.quantity, pricing.day, pricing.includesVat, pricing.conversionRateBp);
    lines.push({
      productId: product.id,
      name: product.name,
      quantity: item.quantity,
      unitPriceAgorot: price.priceAgorot,
      source: price.source,
      priceListId: price.priceListId,
      vatExempt: product.vatKind !== "taxable",
    });
  }
  const result = documentTotals(
    lines.map((line) => ({ quantity: line.quantity, unitPriceAgorot: line.unitPriceAgorot, vatExempt: line.vatExempt })),
    { rateBp: pricing.documentRateBp, pricesIncludeVat: pricing.includesVat },
  );
  if (!result.ok) return { ok: false, reason: "totals", error: result.error };
  return { ok: true, lines, totals: result.totals };
}

export type SaleCustomer = { contactId: string } | { newContact: { firstName: string; lastName: string | null; phone: string | null } };

export const QUICK_SALE_CHEQUES_MAX = 36;

export type SaleCheque = {
  cheque_number: string;
  cheque_bank: string;
  cheque_bank_name: string | null;
  cheque_branch: string | null;
  cheque_due_date: string;
  cheque_status: (typeof QUICK_SALE_CHEQUE_STATUSES)[number];
  amount_agorot: number;
};

export type SalePayment = {
  method: PaymentMethod;
  installments: number | null;
  reference: string | null;
  // PAY-04 (owner, 26 October 2026): a series of cheques, each its own payment, adding up exactly to the total
  cheques: SaleCheque[] | null;
};

/**
 * The even split of a total over n cheques, in whole agorot: every cheque gets the floor share and the first ones one
 * agora more until the total is reached, so the amounts always add up exactly.
 */
export function splitEvenly(totalAgorot: number, n: number): number[] {
  if (!Number.isSafeInteger(totalAgorot) || totalAgorot < n || !Number.isInteger(n) || n < 1) return [];
  const base = Math.floor(totalAgorot / n);
  const extra = totalAgorot - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Whether the cheques' amounts add up exactly to the total (the database refuses otherwise, quick_sale:cheques_total). */
export function chequesAddUp(cheques: readonly { amount_agorot: number }[], totalAgorot: number): boolean {
  return cheques.reduce((sum, c) => sum + c.amount_agorot, 0) === totalAgorot;
}

/** The JSON public.quick_sale takes. */
export function quickSaleBody(
  customer: SaleCustomer,
  lines: readonly PricedLine[],
  payment: SalePayment,
  document: { docType: QuickSaleDocType; number: string } | null,
  expectedTotalAgorot: number,
  dealName: string,
) {
  return {
    deal_name: dealName,
    ...("contactId" in customer
      ? { contact_id: customer.contactId }
      : { new_contact: { first_name: customer.newContact.firstName, last_name: customer.newContact.lastName, phone: customer.newContact.phone } }),
    lines: lines.map((line) => ({
      product_id: line.productId,
      quantity: line.quantity,
      unit_price_agorot: line.unitPriceAgorot,
      price_source: line.source,
      price_list_id: line.priceListId,
    })),
    payment: {
      method: payment.method,
      installments: payment.method === "credit" ? (payment.installments ?? 1) : null,
      reference: payment.reference,
      cheques: payment.method === "cheque" ? payment.cheques : null,
    },
    document: document ? { doc_type: document.docType, number: document.number } : null,
    expected_total_agorot: expectedTotalAgorot,
  };
}
