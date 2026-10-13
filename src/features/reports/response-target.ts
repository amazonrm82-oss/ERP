import { formatNumber } from "@/lib/format";

/**
 * Labels of the response time report (SPD-06), built from the target the
 * database returns (`target_minutes`), never hard-coded: 60 minutes by default
 * until CAP-10 lets each business set its own.
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
