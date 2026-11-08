// PKG-01: a punch card's balance, worked out when read (never stored). PKG-02 adds the entries held meetings use; the
// database decides which card a held meeting uses (app.meetings_punch_card_use); this only shows the result.

export const PUNCH_CARD_STATUSES = ["pending", "active", "cancelled"] as const;
export type PunchCardStatus = (typeof PUNCH_CARD_STATUSES)[number];

export const PUNCH_VALIDITY_UNITS = ["days", "months"] as const;
export type PunchValidityUnit = (typeof PUNCH_VALIDITY_UNITS)[number];

// Spec 22.9: "נשארו מעט" = 2 entries
export const PUNCH_LOW_ENTRIES = 2;
export const PUNCH_ENTRIES_MAX = 1000;
export const PUNCH_VALIDITY_MAX = 3660;
export const PUNCH_REASON_MAX = 500;

export type PunchCardState = "pending" | "active" | "used_up" | "expired" | "cancelled";

export type PunchBalance = {
  total: number;
  used: number;
  remaining: number;
  state: PunchCardState;
  // an active card that is not expired and has entries left
  usable: boolean;
  // usable, with the business's few-left number (PKG-03; PUNCH_LOW_ENTRIES by default) or fewer left; never when it is 0
  low: boolean;
};

/**
 * The balance of one card: entries not given back count as used. A card is expired from the day after its expires_on
 * (expires_on is the last day it may be used), by the business's calendar day `today` (YYYY-MM-DD). An expired card keeps
 * showing its balance and cannot be used.
 */
export function punchBalance(
  card: { status: string; entriesTotal: number; expiresOn: string | null },
  liveUses: number,
  today: string,
  lowEntries: number = PUNCH_LOW_ENTRIES,
): PunchBalance {
  const used = Math.max(0, liveUses);
  const remaining = Math.max(0, card.entriesTotal - used);
  let state: PunchCardState;
  if (card.status === "cancelled") state = "cancelled";
  else if (card.status !== "active") state = "pending";
  else if (card.expiresOn !== null && card.expiresOn < today) state = "expired";
  else if (remaining === 0) state = "used_up";
  else state = "active";
  const usable = state === "active";
  return { total: card.entriesTotal, used, remaining, state, usable, low: usable && lowEntries > 0 && remaining <= lowEntries };
}

export const PUNCH_STATE_LABELS: Record<PunchCardState, string> = {
  pending: "ממתינה לתשלום",
  active: "פעילה",
  used_up: "נוצלה",
  expired: "פג תוקף",
  cancelled: "בוטלה",
};

export const PUNCH_STATE_TONE: Record<PunchCardState, "neutral" | "accent" | "success" | "warning" | "danger"> = {
  pending: "warning",
  active: "success",
  used_up: "neutral",
  expired: "neutral",
  cancelled: "neutral",
};

/** "10 כניסות, בתוקף 3 חודשים מההפעלה" */
export function punchSettingsText(entries: number | null, validityCount: number | null, validityUnit: string | null): string {
  if (entries === null) return "עוד לא הוגדר מספר כניסות";
  const count = entries === 1 ? "כניסה אחת" : `${entries} כניסות`;
  if (validityCount === null || validityUnit === null) return `${count}, בלי תוקף`;
  const period =
    validityUnit === "months" ? (validityCount === 1 ? "חודש אחד" : `${validityCount} חודשים`) : validityCount === 1 ? "יום אחד" : `${validityCount} ימים`;
  return `${count}, בתוקף ${period} מההפעלה`;
}

/** "נשארו 3 מתוך 10" */
export function remainingText(balance: Pick<PunchBalance, "remaining" | "total">): string {
  return balance.remaining === 1 ? `נשארה כניסה אחת מתוך ${balance.total}` : `נשארו ${balance.remaining} מתוך ${balance.total}`;
}

/**
 * Owner (84) ב: the refund a cancelled card suggests: its unused entries out of its total, times what it was sold for,
 * rounded half up to agorot. The person may change it or close without a refund.
 */
export function refundSuggestion(remaining: number, total: number, priceAgorot: number): number {
  if (!(total > 0) || remaining <= 0 || priceAgorot <= 0) return 0;
  return Math.round((Math.min(remaining, total) * priceAgorot) / total);
}

/** "120.5" from agorot, for a money input. */
export function moneyInput(agorot: number): string {
  return agorot % 100 === 0 ? String(agorot / 100) : (agorot / 100).toFixed(2);
}
