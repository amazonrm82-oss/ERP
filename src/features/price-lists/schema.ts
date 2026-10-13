import { z } from "zod";

import { checkbox, moneyField, optionalDate, requiredText } from "@/lib/validation";

// PL-01: a further price list (SPEC-ADDITIONS 4.3). The default price list is
// the product's own price and has no row. Mirrors the checks of
// public.price_lists (migration price_lists).

export const PRICE_LIST_NAME_MAX = 120;

// shown instead of the forms when the plan lacks the 'price_lists' capability
export const PRICE_LISTS_NOT_IN_PLAN =
  'מחירונים אינם כלולים בחבילה הנוכחית. מחירונים שכבר קיימים נשארים לקריאה. בעלי העסק רואים את השימוש ב"הגדרות > חבילה ושימוש", ושם גם איך מגדילים את החבילה.';

// the value of the hidden "vat_choice" field next to an editable VAT setting
export const VAT_CHOICE = "1";

export const priceListSchema = z
  .object({
    name: requiredText(PRICE_LIST_NAME_MAX, "יש להזין שם למחירון.", `השם ארוך מדי (עד ${PRICE_LIST_NAME_MAX} תווים).`),
    valid_from: optionalDate,
    valid_to: optionalDate,
    is_active: checkbox,
    prices_include_vat: checkbox,
    // "1" when the form offers the VAT setting; absent when it is locked (the list has prices)
    vat_choice: z.unknown().optional(),
  })
  // price_lists_valid_range; "YYYY-MM-DD" compares as text
  .refine((value) => value.valid_from === null || value.valid_to === null || value.valid_to >= value.valid_from, {
    path: ["valid_to"],
    error: "תאריך הסיום מוקדם מתאריך ההתחלה.",
  })
  // null: leave the setting as it is (locked list), or the business's setting on a new list (trigger price_lists_vat)
  .transform(({ vat_choice, prices_include_vat, ...rest }) => ({
    ...rest,
    prices_include_vat: vat_choice === VAT_CHOICE ? prices_include_vat : null,
  }));

export const PRICE_LIST_FIELD_NAMES = ["name", "valid_from", "valid_to", "is_active", "prices_include_vat", "vat_choice"] as const;

// Owner, 13 October 2026: one VAT setting per list, changeable only while it has no prices.
export const PRICES_VAT_LABEL = 'המחירים במחירון זה כוללים מע"מ';
export const PRICES_VAT_LOCKED = "יש כבר מחירים במחירון, ולכן אי אפשר לשנות את ההגדרה. כדי לעבוד אחרת, צרו מחירון חדש.";

/** The heading over a list's prices: "מחיר (כולל מע"מ)" or "מחיר (לפני מע"מ)". */
export function priceHeading(pricesIncludeVat: boolean): string {
  return pricesIncludeVat ? 'מחיר (כולל מע"מ)' : 'מחיר (לפני מע"מ)';
}

export type PriceListInput = z.infer<typeof priceListSchema>;

// PL-02: a line of a price list. Mirrors the checks of public.price_list_lines (migration price_list_lines).

export const LINE_RULES = ["price", "discount"] as const;
export type LineRule = (typeof LINE_RULES)[number];
export const LINE_RULE_LABELS: Record<LineRule, string> = { price: "מחיר קבוע", discount: "הנחה באחוזים" };

// price_list_lines.min_quantity is numeric(12,3)
export const MIN_QUANTITY_MAX = 999_999_999;
// price_list_lines_price check, like products
export const LINE_PRICE_MAX_AGOROT = 1_000_000_000_000;
// tiers per product in one list (app.price_list_lines_check)
export const TIERS_PER_PRODUCT = 20;

const text = z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string());

/** "10", "2.5", "0.125" or empty (= 0, any quantity), at most three decimals. */
export const minQuantityField = text.transform((value, ctx) => {
  const cleaned = value.replace(/,/g, "");
  if (cleaned === "") return 0;
  if (!/^\d{1,9}(\.\d{1,3})?$/.test(cleaned) || Number(cleaned) > MIN_QUANTITY_MAX) {
    ctx.addIssue({ code: "custom", message: "כמות במספרים, עד שלוש ספרות אחרי הנקודה. ריק: כל כמות." });
    return z.NEVER;
  }
  return Number(cleaned);
});

/** "10" or "12.5" percent -> basis points (1000, 1250); from 0.01% to 100%. */
export const discountField = text.transform((value, ctx) => {
  const cleaned = value.replace(/%/g, "").trim();
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(cleaned);
  const bp = match ? Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0")) : NaN;
  if (!match || bp < 1 || bp > 10000) {
    ctx.addIssue({ code: "custom", message: "אחוז הנחה בין 0.01 ל-100, למשל 10 או 12.5." });
    return z.NEVER;
  }
  return bp;
});

const lineBase = z.object({
  product_id: z.preprocess((value) => (typeof value === "string" ? value : ""), z.guid({ error: "יש לבחור מוצר." })),
  min_quantity: minQuantityField,
  rule: z.preprocess((value) => (typeof value === "string" ? value : ""), z.enum(LINE_RULES, { error: "יש לבחור מחיר קבוע או הנחה." })),
  price_agorot: z.unknown(),
  discount: z.unknown(),
});

const priceRequired = text.transform((value, ctx) => {
  const parsed = moneyField.safeParse(value);
  if (value === "") {
    ctx.addIssue({ code: "custom", message: "יש להזין מחיר." });
    return z.NEVER;
  }
  if (!parsed.success || parsed.data > LINE_PRICE_MAX_AGOROT) {
    ctx.addIssue({ code: "custom", message: parsed.success ? "המחיר גבוה מדי." : "יש להזין סכום בשקלים, למשל 12,500." });
    return z.NEVER;
  }
  return parsed.data;
});

/**
 * One tier of one product: a fixed price or a discount off the product's own
 * price, from a quantity. Exactly one of price_agorot and discount_bp comes out
 * set (price_list_lines_one_rule). A fixed price is typed in the list's VAT
 * mode; the database copies the list's flag onto the line (trigger
 * price_list_lines_vat), so the form carries no mode of its own.
 */
export const priceListLineSchema = lineBase.transform((value, ctx) => {
  if (value.rule === "price") {
    const price = priceRequired.safeParse(value.price_agorot);
    if (!price.success) {
      ctx.addIssue({ code: "custom", path: ["price_agorot"], message: price.error.issues[0]?.message ?? "יש להזין מחיר." });
      return z.NEVER;
    }
    return {
      product_id: value.product_id,
      min_quantity: value.min_quantity,
      price_agorot: price.data,
      discount_bp: null,
    };
  }
  const discount = discountField.safeParse(value.discount);
  if (!discount.success) {
    ctx.addIssue({ code: "custom", path: ["discount"], message: discount.error.issues[0]?.message ?? "יש להזין אחוז הנחה." });
    return z.NEVER;
  }
  return { product_id: value.product_id, min_quantity: value.min_quantity, price_agorot: null, discount_bp: discount.data };
});

export const PRICE_LIST_LINE_FIELD_NAMES = ["product_id", "min_quantity", "rule", "price_agorot", "discount"] as const;

export type PriceListLineInput = z.infer<typeof priceListLineSchema>;
