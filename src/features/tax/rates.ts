import { isCalendarDate } from "@/lib/calendar-date";
import { VAT_BEFORE_TABLE } from "@/lib/errors";

/**
 * VAT rates by effective date (TAX-03). The rates come from public.vat_rates,
 * never from code; vatRateAt() mirrors app.vat_rate_at(): the rate of the latest
 * row whose effective day is on or before the document's day, null before the
 * first row. Rates are basis points (1800 = 18%), like money in agorot.
 */
export type VatRate = { effectiveFrom: string; rateBp: number };

/** The rate in force on a calendar day (YYYY-MM-DD, in the business's time zone), or null. */
export function vatRateAt(rates: readonly VatRate[], day: string): number | null {
  if (!isCalendarDate(day)) return null;
  let best: VatRate | null = null;
  for (const rate of rates) {
    // ISO calendar days compare as strings
    if (rate.effectiveFrom <= day && (best === null || rate.effectiveFrom > best.effectiveFrom)) best = rate;
  }
  return best?.rateBp ?? null;
}

/** "18%" or "17.5%" from basis points. */
export function vatRateLabel(rateBp: number): string {
  return `${(rateBp / 100).toLocaleString("he-IL", { maximumFractionDigits: 2 })}%`;
}

/**
 * What a document shows for VAT, from the business's status (TAX-01, chargesVat())
 * and the rate of the document's day:
 * - none: the business does not charge VAT; no VAT line at all.
 * - unknown: the status is not set, or no rate is known for that day; the
 *   document code must ask instead of guessing.
 * - rate: the VAT line uses this rate.
 */
export type DocumentVat = { kind: "none" } | { kind: "unknown"; missing: "status" | "rate" } | { kind: "rate"; rateBp: number };

export function documentVat(charges: boolean | null, rates: readonly VatRate[], day: string): DocumentVat {
  if (charges === false) return { kind: "none" };
  if (charges === null) return { kind: "unknown", missing: "status" };
  const rateBp = vatRateAt(rates, day);
  return rateBp === null ? { kind: "unknown", missing: "rate" } : { kind: "rate", rateBp };
}

export const VAT_STATUS_MISSING = 'עוד לא נקבע המעמד של העסק במע"מ. בעלי העסק קובעים אותו ב"הגדרות > מע"מ ופרטים למסמכים".';

/** Why a document cannot be priced yet, in Hebrew; null when it can. Same text as the database hint vat:before_table. */
export function documentVatError(vat: DocumentVat): string | null {
  if (vat.kind !== "unknown") return null;
  return vat.missing === "rate" ? VAT_BEFORE_TABLE : VAT_STATUS_MISSING;
}
