// DOC-04 (owner, 21 October 2026): the entries the database writes when a document is recorded or cancelled and when a
// payment is received or cancelled (app.accounting_documents_timeline / app.payments_timeline, migration money_timeline).
// The stored body is the text: type and number, or the payment method; never an amount. Since the owner's second answers
// (25 October 2026, migration payment_timeline_states) a payment that fails or is refunded is written too.

export const MONEY_ENTRY_KINDS = [
  "document_recorded",
  "document_cancelled",
  "payment_received",
  "payment_cancelled",
  "payment_failed",
  "payment_refunded",
] as const;
export type MoneyEntryKind = (typeof MONEY_ENTRY_KINDS)[number];

/** The kind of a document or payment entry (always a system entry), or null for any other entry. */
export function moneyEntryKind(type: string, kind: string | null): MoneyEntryKind | null {
  return type === "system" && (MONEY_ENTRY_KINDS as readonly (string | null)[]).includes(kind) ? (kind as MoneyEntryKind) : null;
}

/** The entry's label on the timeline. */
export function moneyEntryLabel(kind: MoneyEntryKind): string {
  return kind.startsWith("document_") ? "מסמך" : "תשלום";
}
