import { unitPriceFor, type PriceListForPricing, type PricedProduct } from "@/features/price-lists/price";
import { priceListApplies, type PriceListTerms } from "@/features/price-lists/status";
import type { LineSums } from "@/features/deals/recurring";
import { productPriceFor } from "@/features/products/price";
import type { Billing } from "@/features/products/schema";
import { documentTotals, documentVatRateBp, type TotalsLine, type TotalsResult } from "@/features/tax/calc";
import { vatRateAt, type DocumentVat, type VatRate } from "@/features/tax/rates";

/**
 * Pricing of the product lines on a deal (DLI-01, DLI-02, PL-03). Pure, so the
 * picker can show the same price the server saves.
 *
 * - One VAT mode per deal (migration deal_lines): the mode of its lines, else the
 *   business's setting (TAX-04). Every unit price on the deal is in that mode.
 * - The customer's price list (PL-03, owner's order of 14 October 2026): the first
 *   that applies of the deal's contact's own list, that contact's company's list,
 *   the deal's own company's list; else the product's own price
 *   (pickCustomerList()). The list is chosen when a line is added and stored on it.
 * - The price for (product, list, quantity, day) is unitPriceFor() (quantity
 *   tiers; only a list that is active and valid on the day, in the business's
 *   time zone), then productPriceFor() carries it into the deal's mode at the
 *   day's rate.
 * - The amounts are documentTotals(), the one totals rule (TAX-05). The database
 *   computes each line's total with app.document_totals on that line alone.
 */

export type DealLineSource = "product" | "price_list" | "manual";
export const DEAL_LINE_SOURCES: readonly DealLineSource[] = ["product", "price_list", "manual"];

export function isDealLineSource(value: unknown): value is DealLineSource {
  return typeof value === "string" && (DEAL_LINE_SOURCES as readonly string[]).includes(value);
}

/** The deal's VAT mode: its first line's, else the business's setting. Mirrors app.deal_lines_check. */
export function dealLinesMode(lines: ReadonlyArray<{ priceIncludesVat: boolean }>, businessIncludesVat: boolean): boolean {
  return lines.length > 0 ? lines[0].priceIncludesVat : businessIncludesVat;
}

/**
 * PL-03: the customer's price list for a deal line, by the owner's order (14 October 2026):
 *   1. the deal's contact's own list; 2. else that contact's company's list;
 *   3. else the deal's own company's list (also when the deal has a contact and neither the
 *      contact nor its company has one); 4. else none (the product's own price).
 * A list is used only while it applies on the day (active and within its dates, the business's
 * time zone). A list that is set but does not apply is passed over and the next one is tried
 * (fall through): an expired or inactive list on the contact should not hide a list that is in
 * force on the company. The plan flag 'price_lists' is checked by the caller.
 * candidates: in the order above; null where there is no list (or it is not readable).
 */
export function pickCustomerList<T extends PriceListTerms>(candidates: ReadonlyArray<T | null>, day: string): T | null {
  for (const list of candidates) {
    if (list !== null && priceListApplies(list, day)) return list;
  }
  return null;
}

/**
 * The rate that carries a price between the two VAT modes: the document's rate
 * (0 when the business charges no VAT), else, while the VAT status is not set,
 * the platform's rate of the day; 0 when even that is unknown.
 */
export function conversionRateBp(vat: DocumentVat, rates: readonly VatRate[], day: string): number {
  return documentVatRateBp(vat) ?? vatRateAt(rates, day) ?? 0;
}

export type NamedPriceList = PriceListForPricing & { id: string; name: string };

export type PulledPrice = {
  priceAgorot: number;
  source: Exclude<DealLineSource, "manual">;
  priceListId: string | null;
  priceListName: string | null;
};

/** The unit price of a product on a deal line, in the deal's mode. */
export function pulledPrice(
  product: PricedProduct,
  list: NamedPriceList | null,
  quantity: number,
  day: string,
  lineIncludesVat: boolean,
  rateBp: number,
): PulledPrice {
  const unit = unitPriceFor(product, list, quantity, day);
  const priceAgorot = productPriceFor({ priceAgorot: unit.priceAgorot, priceIncludesVat: unit.priceIncludesVat, vatKind: product.vatKind }, lineIncludesVat, rateBp);
  if (unit.source === "product" || list === null) {
    return { priceAgorot, source: "product", priceListId: null, priceListName: null };
  }
  return { priceAgorot, source: "price_list", priceListId: list.id, priceListName: list.name };
}

export type StoredLinePrice = { unitPriceAgorot: number; quantity: number; source: DealLineSource; hasProduct: boolean };

/**
 * What an edit does to the unit price:
 * - "manual": the person typed a price other than the stored one; it is theirs from now on.
 * - "pull": the price box was emptied on a product line (back to the automatic price), or the
 *   quantity changed while the price is still the automatic one, so a quantity tier may apply.
 * - "keep": nothing about the price changed.
 * A free line's price is always the person's ("manual"); an empty one is an error for the form.
 */
export function priceOnEdit(stored: StoredLinePrice, typedAgorot: number | null, quantity: number): "manual" | "pull" | "keep" | "missing" {
  if (typedAgorot === null) return stored.hasProduct ? "pull" : "missing";
  if (typedAgorot !== stored.unitPriceAgorot) return "manual";
  if (stored.hasProduct && stored.source !== "manual" && quantity !== stored.quantity) return "pull";
  return "keep";
}

export type DealLineAmounts = Pick<TotalsLine, "quantity" | "unitPriceAgorot" | "discountBp" | "discountAgorot" | "vatExempt">;

/**
 * The totals of a deal's lines. rateBp null: the VAT status of the business is
 * not set, so the totals are worked out without VAT and the screen says so.
 */
export function dealLinesTotals(lines: readonly DealLineAmounts[], rateBp: number | null, pricesIncludeVat: boolean): TotalsResult {
  return documentTotals(lines, { rateBp: rateBp ?? 0, pricesIncludeVat });
}

/**
 * DLI-03: the lines' sum the deal value follows, before VAT (mirror of app.deal_lines_net): the
 * net total of documentTotals() over all the lines in the deal's mode, carried back by the
 * conversion rate (conversionRateBp()); exempt lines count at their amount. null = no lines.
 */
export function dealLinesNet(lines: readonly DealLineAmounts[], conversionRateBp: number, pricesIncludeVat: boolean): number | null {
  if (lines.length === 0) return null;
  const result = documentTotals(lines, { rateBp: pricesIncludeVat ? conversionRateBp : 0, pricesIncludeVat });
  return result.ok ? result.totals.netTotalAgorot : null;
}

/** A line with its billing mode (deal_lines.billing; null = saved before DLI-04). */
export type DealLineWithBilling = DealLineAmounts & { billing: Billing | null };

/**
 * DLI-04: the lines' sums before VAT per billing mode (mirror of app.deal_lines_sums): documentTotals()
 * per mode group, in the deal's mode, carried back by the conversion rate. A line saved before DLI-04
 * (billing null) counts in the deal's own period (kind: deals.billing_kind). null = no line of that mode.
 */
export function dealLinesSums(lines: readonly DealLineWithBilling[], kind: string | null, conversionRateBp: number, pricesIncludeVat: boolean): LineSums {
  const own: Billing = kind === "monthly" || kind === "yearly" ? kind : "one_time";
  const groups: Record<Billing, DealLineAmounts[]> = { one_time: [], monthly: [], quarterly: [], yearly: [] };
  for (const line of lines) groups[line.billing ?? own].push(line);
  const net = (group: DealLineAmounts[]) => dealLinesNet(group, conversionRateBp, pricesIncludeVat);
  return { once: net(groups.one_time), monthly: net(groups.monthly), quarterly: net(groups.quarterly), yearly: net(groups.yearly) };
}

/** One line's amount after its own discount, as typed: the line part of documentTotals(). */
export function lineTotal(line: DealLineAmounts, pricesIncludeVat: boolean): TotalsResult {
  return documentTotals([line], { rateBp: 0, pricesIncludeVat });
}
