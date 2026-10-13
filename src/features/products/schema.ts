import { z } from "zod";

import { checkbox, moneyField, optionalId, optionalText, requiredText } from "@/lib/validation";

// PRD-01, PRD-02: a product or service in the organization's catalog (SPEC-ADDITIONS 4.2).
// The value lists mirror the check constraints of public.products (migration products).

export const PRODUCT_KINDS = ["product", "service", "subscription", "bundle"] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];
export const PRODUCT_KIND_LABELS: Record<ProductKind, string> = {
  product: "מוצר",
  service: "שירות",
  subscription: "מנוי",
  // PRD-09 (wave 3) adds what a bundle is made of
  bundle: "חבילה",
};

// exempt and zero rate are calculated alike (no VAT) but kept apart (owner's default, TAX-05/06)
export const VAT_KINDS = ["taxable", "exempt", "zero_rate"] as const;
export type VatKind = (typeof VAT_KINDS)[number];
export const VAT_KIND_LABELS: Record<VatKind, string> = {
  taxable: 'חייב במע"מ',
  exempt: 'פטור ממע"מ',
  zero_rate: 'מע"מ בשיעור אפס',
};

export const BILLINGS = ["one_time", "monthly", "quarterly", "yearly"] as const;
export type Billing = (typeof BILLINGS)[number];
export const BILLING_LABELS: Record<Billing, string> = {
  one_time: "חד-פעמי",
  monthly: "חודשי",
  quarterly: "רבעוני",
  yearly: "שנתי",
};

export const PRODUCT_NAME_MAX = 200;
export const PRODUCT_DESCRIPTION_MAX = 4000;
export const PRODUCT_CODE_MAX = 64;
export const DURATION_MAX = 1440;
// products_price_agorot check: up to ten billion shekels
export const PRICE_MAX_AGOROT = 1_000_000_000_000;

const optionalMinutes = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : ""),
  z
    .string()
    .refine((value) => value === "" || (/^\d{1,4}$/.test(value) && Number(value) >= 1 && Number(value) <= DURATION_MAX), {
      error: `משך בדקות, מ-1 עד ${DURATION_MAX}.`,
    })
    .transform((value) => (value === "" ? null : Number(value))),
);

const enumField = <T extends readonly [string, ...string[]]>(values: T, message: string) =>
  z.preprocess((value) => (typeof value === "string" ? value : ""), z.enum(values, { error: message }));

export const productSchema = z
  .object({
    name: requiredText(PRODUCT_NAME_MAX, "יש להזין שם למוצר.", `השם ארוך מדי (עד ${PRODUCT_NAME_MAX} תווים).`),
    description: optionalText(PRODUCT_DESCRIPTION_MAX, `התיאור ארוך מדי (עד ${PRODUCT_DESCRIPTION_MAX} תווים).`),
    sku: optionalText(PRODUCT_CODE_MAX, `המק"ט ארוך מדי (עד ${PRODUCT_CODE_MAX} תווים).`),
    barcode: optionalText(PRODUCT_CODE_MAX, `הברקוד ארוך מדי (עד ${PRODUCT_CODE_MAX} תווים).`),
    category_id: optionalId,
    unit_id: optionalId,
    kind: enumField(PRODUCT_KINDS, "יש לבחור סוג."),
    vat_kind: enumField(VAT_KINDS, 'יש לבחור את סוג המע"מ.'),
    billing: enumField(BILLINGS, "יש לבחור אופן חיוב."),
    price_agorot: moneyField.refine((value) => value <= PRICE_MAX_AGOROT, { error: "המחיר גבוה מדי." }),
    price_includes_vat: checkbox,
    duration_minutes: optionalMinutes,
    is_active: checkbox,
  })
  // only a taxable product's price can include VAT (products_price_vat_mode)
  .transform((value) => ({ ...value, price_includes_vat: value.vat_kind === "taxable" && value.price_includes_vat }));

export const PRODUCT_FIELD_NAMES = [
  "name",
  "description",
  "sku",
  "barcode",
  "category_id",
  "unit_id",
  "kind",
  "vat_kind",
  "billing",
  "price_agorot",
  "price_includes_vat",
  "duration_minutes",
  "is_active",
] as const;

export type ProductInput = z.infer<typeof productSchema>;

/**
 * PRD-02 rule for every document module (quotes, orders, documents, deal
 * lines): a product is offered for a NEW line only when it is active and not
 * archived. Lines that exist keep their copied values.
 */
export function isOfferable(product: { isActive: boolean; archivedAt: string | null }): boolean {
  return product.isActive && product.archivedAt === null;
}

/** The name of a copy (PRD-02): "עותק של …", cut to fit the name column. */
export function copyName(name: string): string {
  return `עותק של ${name}`.slice(0, PRODUCT_NAME_MAX).trimEnd();
}
