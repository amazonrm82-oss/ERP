// LIB-01: an item's validity window (business dates, both ends inclusive and optional). An item outside it is kept and
// marked; pickers (sending to customers, later) offer only items that are active and valid today.

export type LibraryValidity = "valid" | "expired" | "not_yet";

/** Where `today` (YYYY-MM-DD in the business's zone) falls against the window. */
export function libraryValidity(window: { validFrom: string | null; validUntil: string | null }, today: string): LibraryValidity {
  if (window.validUntil !== null && today > window.validUntil) return "expired";
  if (window.validFrom !== null && today < window.validFrom) return "not_yet";
  return "valid";
}

/** Whether an item may be offered to send now: switched on and inside its window. */
export function isLibraryItemOfferable(item: { isActive: boolean; validFrom: string | null; validUntil: string | null }, today: string): boolean {
  return item.isActive && libraryValidity(item, today) === "valid";
}

export const VALIDITY_LABELS: Record<Exclude<LibraryValidity, "valid">, string> = {
  expired: "פג תוקף",
  not_yet: "עוד לא בתוקף",
};
