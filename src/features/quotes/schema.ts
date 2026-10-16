import { z } from "zod";

import { DISCOUNT_KINDS, quantityField, unitPriceField } from "@/features/deal-lines/schema";
import { discountField } from "@/features/price-lists/schema";
import { BILLINGS } from "@/features/products/schema";
import { moneyField, optionalDate, optionalId, optionalText, requiredText } from "@/lib/validation";

// QUO-01, QUO-02: a quote and its lines. Mirrors the checks of public.quotes and public.quote_lines (migration quotes).

export const QUOTE_TITLE_MAX = 200;
export const QUOTE_NOTES_MAX = 4000;
export const QUOTE_TERMS_MAX = 8000;
export const QUOTE_LINE_NAME_MAX = 300;
export const QUOTE_LINE_DESCRIPTION_MAX = 2000;
// app.quote_lines_check
export const QUOTE_LINES_MAX = 200;
// quotes_valid_until is the business's choice; a new quote offers 30 days (SPEC-ADDITIONS 5.1 "תוקף")
export const DEFAULT_VALID_DAYS = 30;

// QUO-11 (statuses); only drafts exist until QUO-07
export const QUOTE_STATUSES = ["draft", "sent", "viewed", "accepted", "rejected", "expired", "cancelled"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
export const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: "טיוטה",
  sent: "נשלחה",
  viewed: "נצפתה",
  accepted: "אושרה",
  rejected: "נדחתה",
  expired: "פגה",
  cancelled: "בוטלה",
};

export function isQuoteStatus(value: unknown): value is QuoteStatus {
  return typeof value === "string" && (QUOTE_STATUSES as readonly string[]).includes(value);
}

// owner, 14 October 2026: "מסמך זה בלי מע"מ" with a reason from a closed list (quotes_no_vat_reason)
export const NO_VAT_REASONS = ["eilat", "abroad", "other"] as const;
export type NoVatReason = (typeof NO_VAT_REASONS)[number];
export const NO_VAT_REASON_LABELS: Record<NoVatReason, string> = {
  eilat: "אילת",
  abroad: 'לקוח בחו"ל',
  other: "אחר",
};
export const NO_VAT_NOTE_MAX = 200;

export function isNoVatReason(value: unknown): value is NoVatReason {
  return typeof value === "string" && (NO_VAT_REASONS as readonly string[]).includes(value);
}

/** "הצעה בלי מע"מ: אילת" / "…: אחר – <note>", as it is shown (and later printed). */
export function noVatText(reason: NoVatReason, note: string | null): string {
  return `הצעה בלי מע"מ: ${reason === "other" && note ? note : NO_VAT_REASON_LABELS[reason]}`;
}

const text = z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string());

const discountKindField = z.preprocess(
  (value) => (typeof value === "string" ? value : ""),
  z.union([z.literal(""), z.enum(DISCOUNT_KINDS)], { error: "יש לבחור סוג הנחה." }),
);

const amountDiscount = text.transform((value, ctx) => {
  const parsed = moneyField.safeParse(value);
  if (value === "" || !parsed.success || parsed.data < 1 || parsed.data > 1_000_000_000_000) {
    ctx.addIssue({ code: "custom", message: "סכום הנחה בשקלים, למשל 50." });
    return z.NEVER;
  }
  return parsed.data;
});

function readDiscount(kind: "" | (typeof DISCOUNT_KINDS)[number], raw: unknown, ctx: z.RefinementCtx): { bp: number | null; agorot: number | null } | null {
  if (kind === "percent") {
    const parsed = discountField.safeParse(raw);
    if (!parsed.success) {
      ctx.addIssue({ code: "custom", path: ["discount"], message: parsed.error.issues[0]?.message ?? "יש להזין אחוז הנחה." });
      return null;
    }
    return { bp: parsed.data, agorot: null };
  }
  if (kind === "amount") {
    const parsed = amountDiscount.safeParse(raw);
    if (!parsed.success) {
      ctx.addIssue({ code: "custom", path: ["discount"], message: parsed.error.issues[0]?.message ?? "יש להזין סכום הנחה." });
      return null;
    }
    return { bp: null, agorot: parsed.data };
  }
  return { bp: null, agorot: null };
}

/** QUO-02: the quote's own details (the header of the editor). */
export const quoteHeaderSchema = z
  .object({
    title: requiredText(QUOTE_TITLE_MAX, "יש להזין כותרת להצעה.", `הכותרת ארוכה מדי (עד ${QUOTE_TITLE_MAX} תווים).`),
    valid_until: optionalDate,
    notes: optionalText(QUOTE_NOTES_MAX, `ההערות ארוכות מדי (עד ${QUOTE_NOTES_MAX} תווים).`),
    terms: optionalText(QUOTE_TERMS_MAX, `התנאים ארוכים מדי (עד ${QUOTE_TERMS_MAX} תווים).`),
    discount_kind: discountKindField,
    discount: z.unknown(),
    // the form sends the marker only while it shows the no-VAT choice (a business that charges VAT)
    no_vat_shown: z.unknown().optional(),
    no_vat_reason: z.preprocess(
      (value) => (typeof value === "string" ? value : ""),
      z.union([z.literal(""), z.enum(NO_VAT_REASONS)], { error: "יש לבחור סיבה." }),
    ),
    no_vat_note: optionalText(NO_VAT_NOTE_MAX, `הסיבה ארוכה מדי (עד ${NO_VAT_NOTE_MAX} תווים).`),
  })
  .transform((value, ctx) => {
    const discount = readDiscount(value.discount_kind, value.discount, ctx);
    if (!discount) return z.NEVER;
    const shown = value.no_vat_shown === "1";
    const reason = shown && value.no_vat_reason !== "" ? value.no_vat_reason : null;
    if (reason === "other" && !value.no_vat_note) {
      ctx.addIssue({ code: "custom", path: ["no_vat_note"], message: "יש לכתוב את הסיבה." });
      return z.NEVER;
    }
    return {
      title: value.title,
      validUntil: value.valid_until,
      notes: value.notes,
      terms: value.terms,
      discountBp: discount.bp,
      discountAgorot: discount.agorot,
      // undefined: the choice was not shown; keep what is stored
      noVat: shown ? { reason, note: reason === "other" ? value.no_vat_note : null } : undefined,
    };
  });

export const QUOTE_HEADER_FIELD_NAMES = ["title", "valid_until", "notes", "terms", "discount_kind", "discount", "no_vat_shown", "no_vat_reason", "no_vat_note"] as const;

/** QUO-02: an item line (from the catalog or free) for adding and editing. */
export const quoteLineSchema = z
  .object({
    product_id: optionalId,
    name: requiredText(QUOTE_LINE_NAME_MAX, "יש להזין שם לשורה.", `השם ארוך מדי (עד ${QUOTE_LINE_NAME_MAX} תווים).`),
    description: optionalText(QUOTE_LINE_DESCRIPTION_MAX, `התיאור ארוך מדי (עד ${QUOTE_LINE_DESCRIPTION_MAX} תווים).`),
    quantity: quantityField,
    unit_price: unitPriceField,
    discount_kind: discountKindField,
    discount: z.unknown(),
    vat_exempt: z.unknown().optional(),
    vat_exempt_shown: z.unknown().optional(),
    billing: z.preprocess(
      (value) => (typeof value === "string" ? value : ""),
      z.union([z.literal(""), z.enum(BILLINGS)], { error: "יש לבחור אופן חיוב." }),
    ),
    is_optional: z.unknown().optional(),
    optional_selected: z.unknown().optional(),
  })
  .transform((value, ctx) => {
    const discount = readDiscount(value.discount_kind, value.discount, ctx);
    if (!discount) return z.NEVER;
    const isOptional = value.is_optional === "on";
    return {
      productId: value.product_id,
      name: value.name,
      description: value.description,
      quantity: value.quantity,
      unitPriceAgorot: value.unit_price,
      discountBp: discount.bp,
      discountAgorot: discount.agorot,
      vatExempt: value.vat_exempt_shown === "1" ? value.vat_exempt === "on" : null,
      billing: value.billing === "" ? null : value.billing,
      isOptional,
      optionalSelected: isOptional && value.optional_selected === "on",
    };
  });

export type QuoteLineInput = z.infer<typeof quoteLineSchema>;

export const QUOTE_LINE_FIELD_NAMES = [
  "product_id",
  "name",
  "description",
  "quantity",
  "unit_price",
  "discount_kind",
  "discount",
  "vat_exempt",
  "vat_exempt_shown",
  "billing",
  "is_optional",
  "optional_selected",
] as const;

/** QUO-02: a group heading. */
export const quoteGroupSchema = z.object({
  name: requiredText(QUOTE_LINE_NAME_MAX, "יש להזין כותרת לקבוצה.", `הכותרת ארוכה מדי (עד ${QUOTE_LINE_NAME_MAX} תווים).`),
});

/** A new quote's title: the deal's name or the contact's name. */
export function defaultQuoteTitle(name: string | null): string {
  const base = (name ?? "").trim();
  return Array.from(base === "" ? "הצעת מחיר" : `הצעת מחיר: ${base}`).slice(0, QUOTE_TITLE_MAX).join("").trimEnd();
}
