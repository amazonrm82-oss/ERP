import { isCalendarDate } from "@/lib/calendar-date";

/**
 * ADM-01 (owner, 15 October 2026): the VAT rates of the platform on the admin
 * screen. A rate whose day has begun in Israel is locked (app.vat_rates_guard);
 * only a future one may be corrected or removed (platform_update_vat_rate /
 * platform_remove_vat_rate). Removed rows are cancelled, never listed.
 */
export type AdminVatRate = { id: string; effectiveFrom: string; rateBp: number; note: string | null };

/**
 * in_force: the rate documents of today use. future: starts after today, may
 * still change. past: an older rate, replaced by a later one (locked too).
 */
export type VatRateStatus = "in_force" | "future" | "past";

export const VAT_RATE_STATUS_LABELS: Record<VatRateStatus, string> = {
  in_force: "בתוקף",
  future: "עתידי",
  past: "הוחלף",
};

/** The rows with their status, newest day first. `today` is the calendar day in Israel. */
export function withVatRateStatus(rates: readonly AdminVatRate[], today: string): Array<AdminVatRate & { status: VatRateStatus }> {
  const sorted = [...rates].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : 0));
  const current = sorted.find((rate) => rate.effectiveFrom <= today)?.id ?? null;
  return sorted.map((rate) => ({
    ...rate,
    status: rate.effectiveFrom > today ? "future" : rate.id === current ? "in_force" : "past",
  }));
}

/**
 * "18", "17.5", "18%" or "17,5" -> basis points (1800, 1750). At most two
 * decimals, 0% to 100% (the table's check). null when it is not a rate.
 */
export function parseVatPercent(input: string): number | null {
  const text = input.trim().replace(/%$/, "").trim().replace(",", ".");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return null;
  const bp = Math.round(Number(text) * 100);
  return bp >= 0 && bp <= 10_000 ? bp : null;
}

/** "18" or "17.5" from basis points, for a form field. */
export function vatPercentInput(rateBp: number): string {
  return String(rateBp / 100);
}

/** A day the platform may still set a rate on: a calendar day after today (Israel). */
export function isFutureVatDay(day: string, today: string): boolean {
  return isCalendarDate(day) && day > today;
}
