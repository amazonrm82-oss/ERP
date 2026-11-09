import { zoneDate } from "@/lib/format";

// PKG-01, PKG-02 (reviews 2 to 4): what of a punch card a person's export carries: only what belongs to the times the
// person held it. A holding is a span of instants: from the card's creation (or the end of the previous holding) to the end
// of theirs (holder_history [{contact, until}]), and the current holder's runs on with no end. A card the person did not
// hold from its creation came to them by a transfer or a merge: its purchase (payment, price, the line it was sold on, who
// opened and activated it) is the first holder's and stays out. A cancel reason counts only when the card was cancelled
// within the person's holdings, a used entry only when it was made within them (by instant). Days shown are the
// business's calendar days.

type Row = Record<string, unknown>;
type HolderEntry = { contact?: unknown; until?: unknown };
export type Holding = { from: Date; until: Date | null };

const PURCHASE_FIELDS = ["payment_id", "price_agorot", "currency", "order_line_id", "quote_line_id", "deal_line_id", "unit_no", "activated_by", "activated_at", "activated_manually", "created_by", "payment_void_at"] as const;

const entries = (history: unknown): HolderEntry[] => (Array.isArray(history) ? (history as HolderEntry[]) : []);
const instant = (value: unknown): Date | null => {
  if (typeof value !== "string") return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
};

/** Every span in which one of `contactIds` held the card; `current` is the card's holder now (an open span). */
export function holdings(createdAt: string, history: unknown, contactIds: readonly string[], current: unknown): Holding[] {
  const spans: Holding[] = [];
  let from = instant(createdAt) ?? new Date(0);
  for (const entry of entries(history)) {
    const until = instant(entry.until);
    if (!until) continue;
    if (typeof entry.contact === "string" && contactIds.includes(entry.contact)) spans.push({ from, until });
    from = until;
  }
  if (typeof current === "string" && contactIds.includes(current)) spans.push({ from, until: null });
  return spans;
}

export const within = (at: Date | null, spans: readonly Holding[]): boolean =>
  at !== null && spans.some((s) => at.getTime() >= s.from.getTime() && (s.until === null || at.getTime() <= s.until.getTime()));

function shown(spans: readonly Holding[], timeZone: string) {
  return spans.map((s) => ({ from: zoneDate(s.from, timeZone), until: s.until ? zoneDate(s.until, timeZone) : null }));
}

// PKG-06: what a payer's export carries of a card another contact (the service recipient) holds: the purchase, never the
// holder, its history or its use
const PAID_FIELDS = ["id", "name", "product_id", "entries_total", "status", "payment_id", "price_agorot", "currency", "order_line_id", "quote_line_id", "unit_no", "activated_at", "expires_on", "cancelled_at", "payer_contact_id", "payer_company_id", "created_at"] as const;

/** A card the person paid for and someone else holds, as their export carries it. */
export function paidCardForExport(card: Row): Row {
  const copy: Row = {};
  for (const field of PAID_FIELDS) if (field in card) copy[field] = card[field];
  return copy;
}

/** A card, as the person's export carries it (their current card or one they held before). */
export function cardForExport(card: Row, uses: Row[], contactIds: readonly string[], timeZone: string): Row {
  const spans = holdings(String(card.created_at), card.holder_history, contactIds, card.contact_id);
  const created = instant(card.created_at);
  const fromCreation = spans.length > 0 && created !== null && spans[0].from.getTime() === created.getTime();
  const copy: Row = { ...card };
  delete copy.former_contact_ids;
  delete copy.holder_history;
  // PKG-06 (review finding 5): who paid is another person's data on the holder's card
  delete copy.payer_contact_id;
  delete copy.payer_company_id;
  if (!fromCreation) for (const field of PURCHASE_FIELDS) delete copy[field];
  // a card held before: its current holder is someone else
  if (!(typeof card.contact_id === "string" && contactIds.includes(card.contact_id))) delete copy.contact_id;
  if (copy.cancel_reason != null && !within(instant(card.cancelled_at), spans)) copy.cancel_reason = null;
  copy.held = shown(spans, timeZone);
  copy.uses = uses.filter((u) => u.card_id === card.id && within(instant(u.created_at), spans));
  return copy;
}
