import { documentTotals, type TotalsResult } from "@/features/tax/calc";

/**
 * QUO-02: the live totals of a quote, by the one totals rule (TAX-05), so the editor shows what the
 * database will store (app.quotes_check). Counted lines: items that are not optional, and optional
 * ones marked selected; a group heading counts nothing. With a no-VAT reason the rate is 0; while the
 * business has no VAT status the rate is null and the totals are worked out without VAT.
 */

export type QuoteLineAmounts = {
  id: string;
  kind: "item" | "group";
  quantity: number;
  unitPriceAgorot: number;
  discountBp: number | null;
  discountAgorot: number | null;
  vatExempt: boolean;
  isOptional: boolean;
  optionalSelected: boolean;
};

export type QuoteTotalsInput = {
  lines: readonly QuoteLineAmounts[];
  // the business's rate for the quote's day: 0 = no VAT, null = status not set
  rateBp: number | null;
  noVat: boolean;
  pricesIncludeVat: boolean;
  discountBp: number | null;
  discountAgorot: number | null;
};

export function isCounted(line: Pick<QuoteLineAmounts, "kind" | "isOptional" | "optionalSelected">): boolean {
  return line.kind === "item" && (!line.isOptional || line.optionalSelected);
}

/** The rate the quote's totals use. */
export function quoteRateBp(input: Pick<QuoteTotalsInput, "rateBp" | "noVat">): number | null {
  return input.noVat ? 0 : input.rateBp;
}

export function quoteTotals(input: QuoteTotalsInput): TotalsResult {
  const counted = input.lines.filter(isCounted).map((line) => ({
    quantity: line.quantity,
    unitPriceAgorot: line.unitPriceAgorot,
    discountBp: line.discountBp,
    discountAgorot: line.discountAgorot,
    vatExempt: line.vatExempt,
  }));
  return documentTotals(counted, {
    rateBp: quoteRateBp(input) ?? 0,
    pricesIncludeVat: input.pricesIncludeVat,
    discountBp: input.discountBp,
    discountAgorot: input.discountAgorot,
  });
}

export type LineWithTotal = Pick<QuoteLineAmounts, "id" | "kind" | "isOptional" | "optionalSelected"> & { totalAgorot: number };

/**
 * The sum of each group: the counted lines after a group heading, up to the next heading, by heading id.
 * Lines before the first heading belong to no group.
 */
export function groupSubtotals(lines: readonly LineWithTotal[]): Map<string, number> {
  const sums = new Map<string, number>();
  let current: string | null = null;
  for (const line of lines) {
    if (line.kind === "group") {
      current = line.id;
      sums.set(line.id, 0);
    } else if (current !== null && isCounted(line)) {
      sums.set(current, (sums.get(current) ?? 0) + line.totalAgorot);
    }
  }
  return sums;
}

/** The ids in the order a drag left them: `moved` placed before `target` (or at the end when target is null). */
export function moveBefore(ids: readonly string[], moved: string, target: string | null): string[] {
  if (moved === target || !ids.includes(moved)) return [...ids];
  const rest = ids.filter((id) => id !== moved);
  const at = target === null ? rest.length : rest.indexOf(target);
  if (at < 0) return [...ids];
  return [...rest.slice(0, at), moved, ...rest.slice(at)];
}
