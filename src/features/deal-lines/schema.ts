import { z } from "zod";

import { discountField } from "@/features/price-lists/schema";
import { BILLINGS, PRODUCT_CODE_MAX, PRODUCT_NAME_MAX } from "@/features/products/schema";
import { TOTALS_MAX_QUANTITY } from "@/features/tax/calc";
import { moneyField, optionalId, optionalText, requiredText } from "@/lib/validation";

// DLI-01: a product line on a deal. Mirrors the checks of public.deal_lines (migration deal_lines).

export const DEAL_LINE_DESCRIPTION_MAX = 1000;
// app.deal_lines_check
export const DEAL_LINES_MAX = 200;
// deal_lines.unit_price_agorot and discount_agorot checks
export const DEAL_LINE_PRICE_MAX_AGOROT = 1_000_000_000_000;

export const DISCOUNT_KINDS = ["percent", "amount"] as const;
export type DiscountKind = (typeof DISCOUNT_KINDS)[number];
export const DISCOUNT_KIND_LABELS: Record<DiscountKind | "", string> = { "": "בלי הנחה", percent: "הנחה באחוזים", amount: "הנחה בסכום" };

const text = z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string());

/** "3", "1.5" or "0.125": more than 0, at most three decimals, at most 1,000,000. Empty = 1. */
export const quantityField = text.transform((value, ctx) => {
  const cleaned = value.replace(/,/g, "");
  if (cleaned === "") return 1;
  if (!/^\d{1,7}(\.\d{1,3})?$/.test(cleaned) || Number(cleaned) <= 0 || Number(cleaned) > TOTALS_MAX_QUANTITY) {
    ctx.addIssue({ code: "custom", message: "כמות גדולה מאפס, עד שלוש ספרות אחרי הנקודה." });
    return z.NEVER;
  }
  return Number(cleaned);
});

/** A unit price in shekels, or null when left empty (a product line then takes its price automatically). */
export const unitPriceField = text.transform((value, ctx) => {
  if (value === "") return null;
  const parsed = moneyField.safeParse(value);
  if (!parsed.success || parsed.data > DEAL_LINE_PRICE_MAX_AGOROT) {
    ctx.addIssue({ code: "custom", message: parsed.success ? "המחיר גבוה מדי." : "יש להזין סכום בשקלים, למשל 120 או 99.90." });
    return z.NEVER;
  }
  return parsed.data;
});

const discountKindField = z.preprocess(
  (value) => (typeof value === "string" ? value : ""),
  z.union([z.literal(""), z.enum(DISCOUNT_KINDS)], { error: "יש לבחור סוג הנחה." }),
);

const amountDiscount = text.transform((value, ctx) => {
  const parsed = moneyField.safeParse(value);
  if (value === "" || !parsed.success || parsed.data < 1 || parsed.data > DEAL_LINE_PRICE_MAX_AGOROT) {
    ctx.addIssue({ code: "custom", message: "סכום הנחה בשקלים, למשל 50." });
    return z.NEVER;
  }
  return parsed.data;
});

/**
 * The form of a line, for adding and editing. The product is set only when the
 * line is added (it never changes later); the discount is a percentage OR an
 * amount, never both (deal_lines_one_discount).
 */
export const dealLineSchema = z
  .object({
    product_id: optionalId,
    description: requiredText(DEAL_LINE_DESCRIPTION_MAX, "יש להזין תיאור.", `התיאור ארוך מדי (עד ${DEAL_LINE_DESCRIPTION_MAX} תווים).`),
    quantity: quantityField,
    unit_price: unitPriceField,
    discount_kind: discountKindField,
    discount: z.unknown(),
    // owner, 14 October 2026: "פטור ממע"מ" on a free line; the form sends the marker only while it shows the box
    vat_exempt: z.unknown().optional(),
    vat_exempt_shown: z.unknown().optional(),
    // DLI-04: a free line's billing mode; a product line sends none (its product's)
    billing: z.preprocess(
      (value) => (typeof value === "string" ? value : ""),
      z.union([z.literal(""), z.enum(BILLINGS)], { error: "יש לבחור אופן חיוב." }),
    ),
  })
  .transform((value, ctx) => {
    let discountBp: number | null = null;
    let discountAgorot: number | null = null;
    if (value.discount_kind === "percent") {
      const parsed = discountField.safeParse(value.discount);
      if (!parsed.success) {
        ctx.addIssue({ code: "custom", path: ["discount"], message: parsed.error.issues[0]?.message ?? "יש להזין אחוז הנחה." });
        return z.NEVER;
      }
      discountBp = parsed.data;
    } else if (value.discount_kind === "amount") {
      const parsed = amountDiscount.safeParse(value.discount);
      if (!parsed.success) {
        ctx.addIssue({ code: "custom", path: ["discount"], message: parsed.error.issues[0]?.message ?? "יש להזין סכום הנחה." });
        return z.NEVER;
      }
      discountAgorot = parsed.data;
    }
    return {
      productId: value.product_id,
      description: value.description,
      quantity: value.quantity,
      unitPriceAgorot: value.unit_price,
      discountBp,
      discountAgorot,
      // null: the box was not shown (a product line, or a business that charges no VAT); keep what is stored
      vatExempt: value.vat_exempt_shown === "1" ? value.vat_exempt === "on" || value.vat_exempt === "true" : null,
      // null: not sent (a product line); keep what is stored
      billing: value.billing === "" ? null : value.billing,
    };
  });

export type DealLineInput = z.infer<typeof dealLineSchema>;

export const DEAL_LINE_FIELD_NAMES = ["product_id", "description", "quantity", "unit_price", "discount_kind", "discount", "vat_exempt", "vat_exempt_shown", "billing"] as const;

export const VAT_EXEMPT_LABEL = 'פטור ממע"מ';

export const LINE_BILLING_LABEL = "אופן חיוב";

// DLI-02: a product made from the picker (owners and admins of a writable business).
export const quickProductSchema = z.object({
  name: requiredText(PRODUCT_NAME_MAX, "יש להזין שם למוצר.", `השם ארוך מדי (עד ${PRODUCT_NAME_MAX} תווים).`),
  sku: optionalText(PRODUCT_CODE_MAX, `המק"ט ארוך מדי (עד ${PRODUCT_CODE_MAX} תווים).`),
  price: text.transform((value, ctx) => {
    const parsed = moneyField.safeParse(value);
    if (!parsed.success || parsed.data > DEAL_LINE_PRICE_MAX_AGOROT) {
      ctx.addIssue({ code: "custom", message: parsed.success ? "המחיר גבוה מדי." : "יש להזין סכום בשקלים, למשל 120." });
      return z.NEVER;
    }
    return parsed.data;
  }),
});

export const QUICK_PRODUCT_FIELD_NAMES = ["name", "sku", "price"] as const;

export const SOURCE_LABELS = {
  product: "מחיר המוצר",
  manual: "מחיר שהוקלד",
} as const;

/** "מחירון: סיטונאי", "מחיר המוצר" or "מחיר שהוקלד": where a line's price came from. */
export function priceSourceText(source: string, listName: string | null): string {
  if (source === "price_list") return listName ? `מחירון: ${listName}` : "ממחירון";
  return source === "product" ? SOURCE_LABELS.product : SOURCE_LABELS.manual;
}

// PL-03 (owner, 14 October 2026): a new contact or company on a deal prices only lines added after it
export const LINES_PRICES_KEPT = "המחירים בשורות הקיימות לא השתנו";
