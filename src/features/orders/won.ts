// DEAL-04 wave 2: the close window's order (pure parts, unit tested).

import { byGender, DEFAULT_TERMS, type OrgTerms } from "@/features/terminology/terms";

export type WonOrderResult = { ok: true; orderId: string; numberDisplay: string | null } | { ok: false; message: string };

/** What the close window says after the save. */
export function wonOrderText(result: WonOrderResult, terms: OrgTerms = DEFAULT_TERMS): string {
  // RVW-49: the deal in the business's own word ("העסקה נסגרה", "התיק נסגר")
  if (!result.ok) return `${terms.deal.theSingular} ${byGender(terms.deal, "נסגר", "נסגרה")}, אבל ההזמנה לא נוצרה: ${result.message}`;
  return result.numberDisplay ? `נוצרה הזמנה ${result.numberDisplay}.` : "נוצרה הזמנה.";
}
