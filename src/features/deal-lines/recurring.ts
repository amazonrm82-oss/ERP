import { BILLING_LABELS, BILLINGS, type Billing } from "@/features/products/schema";

// DLI-04 (owner, 14 October 2026): every deal line keeps a billing mode (deal_lines.billing): a product
// line copies its product's when it is added, a free line is the person's choice (one-time by default).
// The deal's recurring amount comes from the recurring lines only, converted to the deal's period, and
// the value is their first year plus the one-time lines (app.deal_value_rule, dealValueRule()). A
// one-time deal with a recurring line counts the line's first year; the card offers to make the deal
// recurring and never does it by itself. A line saved before DLI-04 has no mode (null) and counts in
// the deal's own period, as it did.

export function isBilling(value: unknown): value is Billing {
  return typeof value === "string" && (BILLINGS as readonly string[]).includes(value);
}

/** ", חיוב חודשי" after a line that bills on a cycle; "" otherwise (one-time, or saved before DLI-04). */
export function lineBillingText(billing: Billing | null | undefined): string {
  if (!billing || billing === "one_time") return "";
  return `, חיוב ${BILLING_LABELS[billing]}`;
}

/** The mode a line saved before DLI-04 counts in: the deal's own period. */
export function ownBilling(kind: string | null | undefined): Billing {
  return kind === "monthly" || kind === "yearly" ? kind : "one_time";
}

export const MAKE_RECURRING_LABEL = "להפוך לעסקה חוזרת";

/**
 * The offer on a one-time deal that has a recurring line, or null: the line is counted by its first
 * year, and the person may make the deal recurring (the card links to the deal's billing kind). A
 * recurring deal has nothing to say: each line counts by its own mode.
 */
export function makeRecurringOffer(kind: string | null | undefined, billings: (Billing | null | undefined)[]): string | null {
  if (ownBilling(kind) !== "one_time") return null;
  const recurring = billings.filter((billing): billing is Billing => isBilling(billing) && billing !== "one_time");
  if (recurring.length === 0) return null;
  const count = recurring.length === 1 ? "שורה אחת" : `${recurring.length} שורות`;
  const kinds = [...new Set(recurring)].map((billing) => BILLING_LABELS[billing]).join(", ");
  return `בעסקה יש חיוב חוזר (${kinds}; ${count}), והעסקה חד-פעמית, ולכן השורות החוזרות נספרות בשווי לפי שנה ראשונה. אפשר להפוך אותה לעסקה חוזרת.`;
}
