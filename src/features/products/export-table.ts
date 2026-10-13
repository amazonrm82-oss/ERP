// PRD-05: the product list as a table for CSV / Excel. The headers are the ones the import wizard
// recognizes (src/features/imports/fields.ts, IMPORT_TARGETS.product), so an exported file imports
// back as it is. Prices are plain numbers in shekels as typed, with "המחיר כולל מע"מ" next to them.

import { categoryLabel, type ProductCategory, type ProductUnit } from "./lists";
import type { Product } from "./queries";
import { BILLING_LABELS, PRODUCT_KIND_LABELS, VAT_KIND_LABELS } from "./schema";

export const PRODUCT_EXPORT_HEADER = [
  "שם המוצר",
  "תיאור",
  'מק"ט',
  "קטגוריה",
  "סוג",
  "יחידת מידה",
  "מחיר",
  'המחיר כולל מע"מ',
  'מע"מ',
  "חיוב",
  "משך בדקות",
  "ברקוד",
  "פעיל",
  "בארכיון",
] as const;

/** Agorot -> "1250.50" (no thousands separator, so it reads back as a number). */
export function plainShekels(agorot: number): string {
  const whole = Math.trunc(agorot / 100);
  const cents = String(agorot % 100).padStart(2, "0");
  return `${whole}.${cents}`;
}

const yesNo = (value: boolean) => (value ? "כן" : "לא");

type ProductForExport = Pick<
  Product,
  | "name"
  | "description"
  | "sku"
  | "categoryId"
  | "kind"
  | "unitId"
  | "priceAgorot"
  | "priceIncludesVat"
  | "vatKind"
  | "billing"
  | "durationMinutes"
  | "barcode"
  | "isActive"
  | "archivedAt"
>;

export function productExportRows(products: ProductForExport[], categories: readonly ProductCategory[], units: readonly ProductUnit[]): string[][] {
  const unitNames = new Map(units.map((u) => [u.id, u.name]));
  return products.map((p) => [
    p.name,
    p.description ?? "",
    p.sku ?? "",
    categoryLabel(categories, p.categoryId) ?? "",
    PRODUCT_KIND_LABELS[p.kind],
    p.unitId ? (unitNames.get(p.unitId) ?? "") : "",
    plainShekels(p.priceAgorot),
    yesNo(p.priceIncludesVat),
    VAT_KIND_LABELS[p.vatKind],
    BILLING_LABELS[p.billing],
    p.durationMinutes === null ? "" : String(p.durationMinutes),
    p.barcode ?? "",
    yesNo(p.isActive),
    yesNo(p.archivedAt !== null),
  ]);
}
