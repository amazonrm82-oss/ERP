import { formatDate, formatMoney } from "@/lib/format";

import { CYCLE_LABELS, type Cycle } from "./schedule";

// SUB-01: how a billing is described in lists and cards.

/** "₪500 חודשי · לפני מע"מ" */
export function billingAmountText(amountAgorot: number, cycle: Cycle): string {
  return `${formatMoney(amountAgorot)} ${CYCLE_LABELS[cycle]} · לפני מע"מ`;
}

/** The next cycle, the end, or nothing for a stopped billing. */
export function nextCycleText(status: string, nextCycleOn: string | null, endDate: string | null): string {
  if (status === "cancelled") return "בוטל";
  if (status === "paused") return "מושהה: לא נוצרים מחזורים";
  if (status === "failed") return "נכשל: יש לבדוק ולחדש";
  if (nextCycleOn) return `המחזור הבא: ${formatDate(nextCycleOn)}`;
  return endDate ? `הסתיים ב-${formatDate(endDate)}` : "אין מחזור קרוב";
}

/** Owner (354) ב: "5 בחודש", or "היום האחרון בחודש" for 0. */
export function billingDayText(day: number): string {
  return day === 0 ? "היום האחרון בחודש" : `${day} בחודש`;
}
