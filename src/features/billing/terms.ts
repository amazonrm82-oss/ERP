// CON-08: a customer's payment terms. Stored on companies and contacts as
// payment_terms + payment_days (migration billing_details, constraint *_payment_terms_shape):
//   immediate  מיידי: due on the document date (no days)
//   net        N days after the document date
//   eom        שוטף + N: N days after the last day of the document's month (שוטף = שוטף + 0)
// COL-02 computes a document's due date with paymentDueDate().

export const PAYMENT_TERMS = ["immediate", "net", "eom"] as const;
export type PaymentTermsKind = (typeof PAYMENT_TERMS)[number];

export const PAYMENT_DAYS_MAX = 365;

export type PaymentTerms = { kind: PaymentTermsKind; days: number | null };

export const PAYMENT_TERMS_LABELS: Record<PaymentTermsKind, string> = {
  immediate: "מיידי",
  net: "ימים מתאריך המסמך",
  eom: "שוטף +",
};

export function isPaymentTermsKind(value: unknown): value is PaymentTermsKind {
  return typeof value === "string" && (PAYMENT_TERMS as readonly string[]).includes(value);
}

/** The stored pair as terms, or null when it is not set or not a shape the database allows. */
export function paymentTermsOf(kind: string | null | undefined, days: number | null | undefined): PaymentTerms | null {
  if (!isPaymentTermsKind(kind)) return null;
  if (kind === "immediate") return days === null || days === undefined ? { kind, days: null } : null;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > PAYMENT_DAYS_MAX) return null;
  return { kind, days };
}

/** "מיידי", "שוטף", "שוטף + 30", "30 ימים מתאריך המסמך". */
export function paymentTermsText(terms: PaymentTerms | null): string | null {
  if (!terms) return null;
  if (terms.kind === "immediate") return "מיידי";
  const days = terms.days ?? 0;
  if (terms.kind === "eom") return days === 0 ? "שוטף" : `שוטף + ${days}`;
  if (days === 0) return "ביום המסמך";
  return days === 1 ? "יום אחד מתאריך המסמך" : `${days} ימים מתאריך המסמך`;
}

function addDays(day: string, n: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

function endOfMonth(day: string): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  // day 0 of the next month is the last day of this one
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/** The due date ("YYYY-MM-DD") of a document dated `documentDay` under these terms. */
export function paymentDueDate(documentDay: string, terms: PaymentTerms): string {
  if (terms.kind === "immediate") return documentDay;
  const days = terms.days ?? 0;
  return terms.kind === "eom" ? addDays(endOfMonth(documentDay), days) : addDays(documentDay, days);
}
