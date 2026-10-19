// DEAL-04 wave 2: the close window's order (pure parts, unit tested).

export type WonOrderResult = { ok: true; orderId: string; numberDisplay: string | null } | { ok: false; message: string };

/** What the close window says after the save. */
export function wonOrderText(result: WonOrderResult): string {
  if (!result.ok) return `העסקה נסגרה, אבל ההזמנה לא נוצרה: ${result.message}`;
  return result.numberDisplay ? `נוצרה הזמנה ${result.numberDisplay}.` : "נוצרה הזמנה.";
}
