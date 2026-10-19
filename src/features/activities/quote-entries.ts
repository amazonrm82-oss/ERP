// QUO-16, the timeline part (owner, 18 October 2026): the entries the database writes when a quote is sent, accepted or
// declined (app.quote_timeline_entry, migration 020335), and since QUO-11 (020400) when it expires or is cancelled. The
// stored body names the number only (a cancellation also who cancelled it); the screen adds the title as the quote reads
// now, so an erased title leaves nothing behind. No amounts.

export const QUOTE_ENTRY_KINDS = ["quote_sent", "quote_accepted", "quote_rejected", "quote_expired", "quote_cancelled"] as const;
export type QuoteEntryKind = (typeof QUOTE_ENTRY_KINDS)[number];

const VERB: Record<QuoteEntryKind, string> = {
  quote_sent: "נשלחה",
  quote_accepted: "אושרה",
  quote_rejected: "נדחתה",
  quote_expired: "פג תוקפה",
  quote_cancelled: "בוטלה",
};

/** The kind of a quote entry, or null for any other entry. "Sent" is a person's note; the others are system entries. */
export function quoteEntryKind(type: string, kind: string | null): QuoteEntryKind | null {
  if (kind === "quote_sent") return type === "note" || type === "system" ? kind : null;
  if (kind === "quote_accepted" || kind === "quote_rejected" || kind === "quote_expired" || kind === "quote_cancelled") {
    return type === "system" ? kind : null;
  }
  return null;
}

const BY = " על ידי ";

/** QUO-11: who cancelled, from the stored body of a cancellation entry (the database writes "... בוטלה על ידי <name>"). */
export function quoteEntryBy(kind: QuoteEntryKind, body: string | null): string | null {
  if (kind !== "quote_cancelled" || !body) return null;
  const at = body.indexOf(BY);
  const name = at < 0 ? "" : body.slice(at + BY.length).trim();
  return name || null;
}

/** "הצעת מחיר QT-7 "שיפוץ מטבח" נשלחה." — the title only when the user still reads the quote. */
export function quoteEntryText(kind: QuoteEntryKind, number: string | null, title: string | null, by: string | null = null): string {
  const name = ["הצעת מחיר", number, title ? `"${title}"` : null].filter(Boolean).join(" ");
  return `${name} ${VERB[kind]}${by ? `${BY}${by}` : ""}.`;
}
