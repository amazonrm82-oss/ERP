import { BILLING_LABELS, BILLINGS, type Billing } from "@/features/products/schema";

// DLI-04: recurring product lines and the deal's recurring revenue.
// The rule today (owner, DLI-03): a recurring deal (monthly / yearly) counts the before-VAT sum of
// ALL its lines as the amount per period; a one-time deal counts them once. A line carries no
// billing of its own: how a catalog product bills (products.billing) is read at display time only,
// to say on the card how each product bills and to warn when the lines do not fit the deal's kind
// (a one-time setup fee in a monthly deal is counted every month). How mixed lines should count is
// an open question for the owner (DECISIONS.md, DLI-04); nothing here changes a stored amount.

export function isBilling(value: unknown): value is Billing {
  return typeof value === "string" && (BILLINGS as readonly string[]).includes(value);
}

/** ", חיוב חודשי" after a product line whose product bills on a cycle; "" otherwise. */
export function lineBillingText(billing: Billing | null | undefined): string {
  if (!billing || billing === "one_time") return "";
  return `, חיוב ${BILLING_LABELS[billing]}`;
}

/** The product billing a deal kind counts its lines by (null = one-time deal). */
function kindBilling(kind: string | null | undefined): Billing {
  return kind === "monthly" || kind === "yearly" ? kind : "one_time";
}

/**
 * A notice when product lines bill differently from the deal's kind, or null. Free lines (and a
 * product the reader could not read) say nothing; an archived product still has its billing.
 */
export function linesBillingNotice(kind: string | null | undefined, billings: (Billing | null | undefined)[]): string | null {
  const deal = kindBilling(kind);
  const known = billings.filter((billing): billing is Billing => isBilling(billing));
  const other = known.filter((billing) => billing !== deal);
  if (other.length === 0) return null;
  const count = other.length === 1 ? "שורה אחת" : `${other.length} שורות`;
  const kinds = [...new Set(other)].map((billing) => BILLING_LABELS[billing]).join(", ");
  if (deal === "one_time") {
    return `בעסקה יש מוצרים בחיוב חוזר (${kinds}; ${count}), אבל העסקה חד-פעמית, ולכן השורות נספרות פעם אחת. כדי לספור אותן כהכנסה חוזרת, משנים את סוג העסקה בפרטי העסקה.`;
  }
  const per = deal === "monthly" ? "לחודש" : "לשנה";
  return `בעסקה ${deal === "monthly" ? "חודשית" : "שנתית"} כל השורות נספרות בסכום ${per}, גם מוצרים שהחיוב שלהם אחר (${kinds}; ${count}).`;
}
