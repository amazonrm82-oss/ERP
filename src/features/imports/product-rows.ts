// PRD-05: one row of a products file -> the columns of public.products, or the reason it cannot be
// imported. Pure (no database): the server resolves categories and units by name and checks
// duplicates by SKU. Used by the import (src/features/imports/product-server.ts) and its unit tests.

import { parseMoneyToAgorot } from "@/lib/format";
import {
  BILLING_LABELS,
  BILLINGS,
  DURATION_MAX,
  PRICE_MAX_AGOROT,
  PRODUCT_CODE_MAX,
  PRODUCT_DESCRIPTION_MAX,
  PRODUCT_KIND_LABELS,
  PRODUCT_KINDS,
  PRODUCT_NAME_MAX,
  VAT_KIND_LABELS,
  VAT_KINDS,
  type Billing,
  type ProductKind,
  type VatKind,
} from "@/features/products/schema";

/** The values of a row that go straight into the products table. */
export type ProductRowValues = {
  name: string;
  description: string | null;
  sku: string | null;
  barcode: string | null;
  kind: ProductKind;
  vat_kind: VatKind;
  billing: Billing;
  price_agorot: number;
  price_includes_vat: boolean;
  duration_minutes: number | null;
  is_active: boolean;
};

export type ParsedProductRow = {
  values: ProductRowValues;
  // resolved by name on the server
  category: string | null;
  unit: string | null;
};

const fold = (text: string) => text.trim().toLowerCase().replace(/["'״׳`]/g, "").replace(/[_\-.:]+/g, " ").replace(/\s+/g, " ");

const lengthOf = (text: string) => Array.from(text).length;

function choice<T extends string>(raw: string, values: readonly T[], labels: Record<T, string>, synonyms: Record<string, T>): T | null {
  const f = fold(raw);
  for (const value of values) {
    if (fold(value) === f || fold(labels[value]) === f) return value;
  }
  return synonyms[f] ?? null;
}

const KIND_SYNONYMS: Record<string, ProductKind> = { פריט: "product", item: "product", "מנוי חודשי": "subscription", package: "bundle", bundle: "bundle" };
const VAT_SYNONYMS: Record<string, VatKind> = {
  חייב: "taxable",
  "חייב מעמ": "taxable",
  "כולל מעמ": "taxable",
  מעמ: "taxable",
  כן: "taxable",
  vat: "taxable",
  פטור: "exempt",
  "פטור ממעמ": "exempt",
  לא: "exempt",
  "no vat": "exempt",
  אפס: "zero_rate",
  "שיעור אפס": "zero_rate",
  "מעמ אפס": "zero_rate",
  "0%": "zero_rate",
  zero: "zero_rate",
  "zero rated": "zero_rate",
};
const BILLING_SYNONYMS: Record<string, Billing> = {
  "חד פעמי": "one_time",
  חדפעמי: "one_time",
  "פעם אחת": "one_time",
  once: "one_time",
  "one time": "one_time",
  חודש: "monthly",
  month: "monthly",
  רבעון: "quarterly",
  quarter: "quarterly",
  שנה: "yearly",
  annual: "yearly",
  annually: "yearly",
  year: "yearly",
};

const TRUE_WORDS = new Set(["כן", "v", "x", "✓", "true", "yes", "y", "1", "פעיל", "כולל", "כולל מעמ", "active"]);
const FALSE_WORDS = new Set(["לא", "false", "no", "n", "0", "לא פעיל", "לפני מעמ", "לא כולל", "לא כולל מעמ", "inactive"]);

/** "כן" / "לא" and the like; undefined when the cell is something else. */
export function parseYesNo(raw: string): boolean | undefined {
  const f = fold(raw);
  if (TRUE_WORDS.has(f)) return true;
  if (FALSE_WORDS.has(f)) return false;
  return undefined;
}

/**
 * A price cell -> agorot. Takes "1,250.50", "₪1250", and a number Excel stored with a binary
 * tail (99.99000000000001); null for anything else.
 */
export function parsePrice(raw: string): number | null {
  const cleaned = raw.replace(/[₪,\s]/g, "");
  if (/^\d+\.\d{3,}$/.test(cleaned)) {
    const cents = Number(cleaned) * 100;
    const rounded = Math.round(cents);
    return Math.abs(cents - rounded) < 1e-6 && Number.isSafeInteger(rounded) ? rounded : null;
  }
  return parseMoneyToAgorot(cleaned);
}

/**
 * Checks one row. `raw` holds the non-empty cells by target key; `pricesIncludeVat` is the
 * organization's setting (TAX-04), used when the file has no "including VAT" column.
 */
export function parseProductRow(raw: Record<string, string>, pricesIncludeVat: boolean): ParsedProductRow | string {
  const name = raw.name?.trim() ?? "";
  if (!name) return "חסר שם למוצר.";
  if (lengthOf(name) > PRODUCT_NAME_MAX) return `השם ארוך מדי (עד ${PRODUCT_NAME_MAX} תווים).`;
  const description = raw.description?.trim() || null;
  if (description && lengthOf(description) > PRODUCT_DESCRIPTION_MAX) return `התיאור ארוך מדי (עד ${PRODUCT_DESCRIPTION_MAX} תווים).`;
  const sku = raw.sku?.trim() || null;
  if (sku && lengthOf(sku) > PRODUCT_CODE_MAX) return `המק"ט ארוך מדי (עד ${PRODUCT_CODE_MAX} תווים).`;
  const barcode = raw.barcode?.trim() || null;
  if (barcode && lengthOf(barcode) > PRODUCT_CODE_MAX) return `הברקוד ארוך מדי (עד ${PRODUCT_CODE_MAX} תווים).`;

  let kind: ProductKind = "product";
  if (raw.kind) {
    const value = choice(raw.kind, PRODUCT_KINDS, PRODUCT_KIND_LABELS, KIND_SYNONYMS);
    if (!value) return `הסוג "${raw.kind}" לא מוכר. אפשר: ${PRODUCT_KINDS.map((k) => PRODUCT_KIND_LABELS[k]).join(", ")}.`;
    kind = value;
  }
  let vatKind: VatKind = "taxable";
  if (raw.vat_kind) {
    const value = choice(raw.vat_kind, VAT_KINDS, VAT_KIND_LABELS, VAT_SYNONYMS);
    if (!value) return `סוג המע"מ "${raw.vat_kind}" לא מוכר. אפשר: חייב, פטור או שיעור אפס.`;
    vatKind = value;
  }
  let billing: Billing = "one_time";
  if (raw.billing) {
    const value = choice(raw.billing, BILLINGS, BILLING_LABELS, BILLING_SYNONYMS);
    if (!value) return `אופן החיוב "${raw.billing}" לא מוכר. אפשר: ${BILLINGS.map((b) => BILLING_LABELS[b]).join(", ")}.`;
    billing = value;
  }

  let price = 0;
  if (raw.price) {
    const value = parsePrice(raw.price);
    if (value === null) return `המחיר "${raw.price}" אינו מספר תקין (למשל 1250 או 1,250.50).`;
    if (value > PRICE_MAX_AGOROT) return "המחיר גבוה מדי.";
    price = value;
  }
  let includesVat = pricesIncludeVat;
  if (raw.price_includes_vat) {
    const value = parseYesNo(raw.price_includes_vat);
    if (value === undefined) return `בעמודה "המחיר כולל מע"מ" צריך להיות כן או לא, ולא "${raw.price_includes_vat}".`;
    includesVat = value;
  }

  let duration: number | null = null;
  if (raw.duration_minutes) {
    const text = raw.duration_minutes.trim();
    if (!/^\d{1,4}$/.test(text) || Number(text) < 1 || Number(text) > DURATION_MAX) return `משך בדקות, מ-1 עד ${DURATION_MAX}.`;
    duration = Number(text);
  }
  let active = true;
  if (raw.is_active) {
    const value = parseYesNo(raw.is_active);
    if (value === undefined) return `בעמודה "פעיל" צריך להיות כן או לא, ולא "${raw.is_active}".`;
    active = value;
  }

  const category = raw.category?.trim() || null;
  const unit = raw.unit?.trim() || null;
  return {
    values: {
      name,
      description,
      sku,
      barcode,
      kind,
      vat_kind: vatKind,
      billing,
      price_agorot: price,
      // only a taxable product's price can include VAT (products_price_vat_mode)
      price_includes_vat: vatKind === "taxable" && includesVat,
      duration_minutes: duration,
      is_active: active,
    },
    category,
    unit,
  };
}

/** The key a SKU is compared by: trimmed, without case (products_sku_idx is on lower(sku)). */
export const skuKey = (sku: string) => sku.trim().toLowerCase();

/** The key a category or unit name is compared by. */
export const nameKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

export type CategoryRef = { id: string; parentId: string | null; name: string };

/** "ראשית > משנה" (also "›" as the app writes it, "/" or "\\") splits into the path of a subcategory. */
export function splitCategoryPath(text: string): string[] {
  return text
    .split(/\s*(?:>|›|\/|\\)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * The category a cell names: a path "ראשית > משנה", or a single name (a top category first, else
 * the one subcategory of that name). "missing" when nothing matches (a single name is then
 * created as a top category; a path is not), "ambiguous" when several subcategories share it.
 */
export function findCategory(categories: CategoryRef[], text: string): { id: string } | "missing" | "missing-path" | "ambiguous" {
  const parts = splitCategoryPath(text);
  if (parts.length === 0) return "missing";
  if (parts.length > 2) return "missing-path";
  if (parts.length === 2) {
    const parent = categories.find((c) => c.parentId === null && nameKey(c.name) === nameKey(parts[0]));
    const child = parent ? categories.find((c) => c.parentId === parent.id && nameKey(c.name) === nameKey(parts[1])) : undefined;
    return child ? { id: child.id } : "missing-path";
  }
  const top = categories.find((c) => c.parentId === null && nameKey(c.name) === nameKey(parts[0]));
  if (top) return { id: top.id };
  const children = categories.filter((c) => c.parentId !== null && nameKey(c.name) === nameKey(parts[0]));
  if (children.length === 1) return { id: children[0].id };
  return children.length > 1 ? "ambiguous" : "missing";
}
