/**
 * PRD-06: cost and gross profit, for those who may see costs (owners, admins, managers and the
 * view_costs grant; the rows come from public.product_costs under RLS, so a caller who may not
 * see costs never has a number to pass here).
 *
 * The cost is stored per unit of the product, as typed: before VAT in a business that charges VAT
 * (the VAT it pays on purchases is offset), the full amount paid in a business that does not. It is
 * compared with the sale price before VAT, so the two always stand on the same footing.
 * Amounts are agorot; rounding is half up, like documentTotals().
 */

export type Profit = {
  profitAgorot: number;
  // gross margin in basis points of the net price (3000 = 30%); null when the net price is 0
  marginBp: number | null;
};

const TWO = BigInt(2);

function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  // numerator may be negative (a loss): round half away from zero
  if (numerator < BigInt(0)) return -divideHalfUp(-numerator, denominator);
  return (numerator * TWO + denominator) / (denominator * TWO);
}

/** Profit and margin of a net price over a cost (both agorot). */
export function profitOf(netAgorot: number, costAgorot: number): Profit {
  if (!Number.isSafeInteger(netAgorot) || !Number.isSafeInteger(costAgorot)) throw new RangeError("amount");
  const profitAgorot = netAgorot - costAgorot;
  const marginBp = netAgorot === 0 ? null : Number(divideHalfUp(BigInt(profitAgorot) * BigInt(10000), BigInt(netAgorot)));
  return { profitAgorot, marginBp };
}

/** The cost of a quantity (up to 3 decimals, like deal_lines.quantity) of units, half up to the agora. */
export function costForQuantity(quantity: number, unitCostAgorot: number): number {
  if (!Number.isFinite(quantity) || quantity < 0) throw new RangeError("quantity");
  if (!Number.isSafeInteger(unitCostAgorot) || unitCostAgorot < 0) throw new RangeError("cost");
  const milli = BigInt(Math.round(quantity * 1000));
  return Number(divideHalfUp(milli * BigInt(unitCostAgorot), BigInt(1000)));
}

export type CostedLine = { productId: string | null; quantity: number; netAgorot: number | null };

export type LinesProfit = Profit & {
  // the net amount and the cost of the lines whose product has a cost
  revenueAgorot: number;
  costAgorot: number;
  // lines left out: free lines, and products with no cost or whose net amount is unknown
  uncosted: number;
};

/**
 * The gross profit of a deal's lines: the net amount of each product line whose product has a cost,
 * less quantity x unit cost. Lines without a cost are counted as left out, never as zero cost.
 * null when no line has a cost.
 */
export function linesProfit(lines: readonly CostedLine[], costs: ReadonlyMap<string, number>): LinesProfit | null {
  let revenue = 0;
  let cost = 0;
  let counted = 0;
  for (const line of lines) {
    const unitCost = line.productId === null ? undefined : costs.get(line.productId);
    if (unitCost === undefined || line.netAgorot === null) continue;
    revenue += line.netAgorot;
    cost += costForQuantity(line.quantity, unitCost);
    counted += 1;
  }
  if (counted === 0) return null;
  return { revenueAgorot: revenue, costAgorot: cost, uncosted: lines.length - counted, ...profitOf(revenue, cost) };
}

/** "30%" / "12.5%" / "-4%" from basis points. */
export function marginText(marginBp: number): string {
  const percent = marginBp / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1).replace(/\.0$/, "")}%`;
}

/** What the cost means in this business (shown next to the field). */
export function costMeaning(chargesVat: boolean | null): string {
  return chargesVat === false ? "העלות ליחידה, כפי ששולמה." : 'העלות ליחידה, לפני מע"מ.';
}
