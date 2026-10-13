// PL-01: whether a price list applies on a day. Dates are calendar days
// ("YYYY-MM-DD") in the organization's time zone; both ends are inclusive and
// either may be empty (no limit).

export type PriceListTerms = { isActive: boolean; validFrom: string | null; validTo: string | null };

export type PriceListStatus = "in_force" | "inactive" | "upcoming" | "ended";

export function priceListStatus(list: PriceListTerms, day: string): PriceListStatus {
  if (!list.isActive) return "inactive";
  if (list.validFrom !== null && day < list.validFrom) return "upcoming";
  if (list.validTo !== null && day > list.validTo) return "ended";
  return "in_force";
}

/** True when the list's prices are used on that day. */
export function priceListApplies(list: PriceListTerms, day: string): boolean {
  return priceListStatus(list, day) === "in_force";
}

export const PRICE_LIST_STATUS_LABELS: Record<PriceListStatus, string> = {
  in_force: "בתוקף",
  inactive: "לא פעיל",
  upcoming: "עוד לא בתוקף",
  ended: "התוקף הסתיים",
};

function day(text: string): string {
  // "09.10.2026", as Israelis write a date
  return `${text.slice(8, 10)}.${text.slice(5, 7)}.${text.slice(0, 4)}`;
}

/** "01.01.2026 עד 31.12.2026", "מ-01.01.2026", "עד 31.12.2026" or "בלי הגבלת זמן". */
export function validityText(list: Pick<PriceListTerms, "validFrom" | "validTo">): string {
  if (list.validFrom && list.validTo) return `${day(list.validFrom)} עד ${day(list.validTo)}`;
  if (list.validFrom) return `מ-${day(list.validFrom)}`;
  if (list.validTo) return `עד ${day(list.validTo)}`;
  return "בלי הגבלת זמן";
}
