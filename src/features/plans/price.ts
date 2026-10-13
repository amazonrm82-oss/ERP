import { formatMoney } from "@/lib/format";

// Prices are before VAT (owner, 13 October 2026), per business or per user.
export const VAT_NOTE = "לא כולל מע\"מ";

export const PRICE_UNIT_LABELS: Record<string, string> = { org: "לעסק", seat: "למשתמש" };

export const AVAILABILITY_LABELS: Record<string, string> = {
  available: "זמינה",
  coming_soon: "בקרוב",
  hidden: "מוסתרת",
};

type Priced = { price_monthly_agorot: number; price_annual_agorot: number; price_unit: string };

/** "79 ₪ לחודש לעסק" / "89 ₪ לחודש למשתמש". */
export function monthlyPriceLabel(plan: Priced): string {
  return `${formatMoney(plan.price_monthly_agorot)} לחודש ${PRICE_UNIT_LABELS[plan.price_unit] ?? ""}`.trim();
}

/** "69 ₪ לחודש לעסק בתשלום שנתי". */
export function annualPriceLabel(plan: Priced): string {
  return `${monthlyPriceLabel({ ...plan, price_monthly_agorot: plan.price_annual_agorot })} בתשלום שנתי`;
}
