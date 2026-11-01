import type { TotalsResult } from "@/features/tax/calc";

import type { QuoteLine } from "./queries";
import { quoteTotals } from "./totals";

/**
 * QUO-08 (owner, 1 November 2026, answer (27) א: "ברירת מחדל: לא מסומנות"): the customer ticks the optional lines they want on
 * the quote's page. Every optional line starts unticked, whatever the rep preselected, so the starting total is the quote
 * without its optional lines (it may differ from the sent total and the PDF; the page says so). The page works the total of the choice
 * out by the one totals rule at the rate the quote was sent with (the database does the same, app.quote_counted_totals), and
 * posts each ticked line by its 1-based place in the page's list (quote_public answers no ids; publicQuoteFrom names the
 * lines `line-<place>`), with the total it showed.
 */

type ChoiceQuote = { vatRateBp: number | null; pricesIncludeVat: boolean; discountBp: number | null; discountAgorot: number | null };

export const isOptionalItem = (line: Pick<QuoteLine, "kind" | "isOptional">) => line.kind === "item" && line.isOptional;

/** The optional lines the page starts with ticked: none (owner, 1 November 2026: "ברירת מחדל: לא מסומנות"). */
export function initialChoice(lines: readonly QuoteLine[]): string[] {
  void lines;
  return [];
}

/** The lines with the customer's choice in place of the rep's preselection. */
export function linesWithChoice(lines: readonly QuoteLine[], ticked: readonly string[]): QuoteLine[] {
  const chosen = new Set(ticked);
  return lines.map((line) => (isOptionalItem(line) ? { ...line, optionalSelected: chosen.has(line.id) } : line));
}

/** The totals of the choice, at the quote's stored rate (0 for a quote without VAT). */
export function choiceTotals(quote: ChoiceQuote, lines: readonly QuoteLine[], ticked: readonly string[]): TotalsResult {
  return quoteTotals({
    lines: linesWithChoice(lines, ticked),
    rateBp: quote.vatRateBp ?? 0,
    noVat: false,
    pricesIncludeVat: quote.pricesIncludeVat,
    discountBp: quote.discountBp,
    discountAgorot: quote.discountAgorot,
  });
}

const PLACE = /^line-([1-9][0-9]{0,2})$/;

/** The places the database knows the ticked lines by, in order; only optional items count. */
export function choiceKeys(lines: readonly QuoteLine[], ticked: readonly string[]): number[] {
  const chosen = new Set(ticked);
  return lines
    .filter((line) => isOptionalItem(line) && chosen.has(line.id))
    .map((line) => Number(PLACE.exec(line.id)?.[1] ?? NaN))
    .filter((place) => Number.isInteger(place))
    .sort((a, b) => a - b);
}
