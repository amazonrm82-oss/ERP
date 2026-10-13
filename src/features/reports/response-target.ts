import { formatNumber } from "@/lib/format";

/**
 * Labels of the response time report (SPD-06), built from the target the
 * database returns (`target_minutes`), never hard-coded: the business's own
 * target (CAP-10, /settings/response), 60 minutes until it sets one.
 */
export function responseTargetLabels(targetMinutes: number) {
  const minutes = formatNumber(targetMinutes);
  return {
    kpi: `נענו בתוך ${minutes} דקות`,
    column: `תוך ${minutes} דק'`,
    /** Shown under the number while business hours (CAP-09) are not counted. */
    clock: "הזמן נספר גם בלילה ובימי מנוחה",
  };
}
