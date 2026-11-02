import { formatNumber } from "@/lib/format";

import { productPriceFor, type ProductPrice } from "./price";

// PRD-09: a bundle is a product of kind 'bundle' made of other products (public.product_bundle_items, migration
// product_bundles). Its price is its own; the parts' sum is shown for reference only. On a document line a bundle is
// shown as one line or itemised (bundle_display); quote and order lines keep the parts as they were (bundle_items).

// app.product_bundle_items_check
export const BUNDLE_PARTS_MAX = 50;

export const BUNDLE_DISPLAYS = ["single", "itemised"] as const;
export type BundleDisplay = (typeof BUNDLE_DISPLAYS)[number];
export const BUNDLE_DISPLAY_LABELS: Record<BundleDisplay, string> = {
  single: "שורה אחת",
  itemised: "מפורט",
};

export function isBundleDisplay(value: unknown): value is BundleDisplay {
  return value === "single" || value === "itemised";
}

/** A part as a document keeps it: name and quantity per one bundle (app.bundle_snapshot). */
export type BundlePartSnapshot = { name: string; quantity: number; unitName: string | null };

/** The parts stored on a quote or order line; anything that is not that shape is left out. */
export function parseBundleItems(value: unknown): BundlePartSnapshot[] {
  if (!Array.isArray(value)) return [];
  const parts: BundlePartSnapshot[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const quantity = Number(row.quantity);
    if (typeof row.name !== "string" || !Number.isFinite(quantity) || quantity <= 0) continue;
    parts.push({ name: row.name, quantity, unitName: typeof row.unit_name === "string" ? row.unit_name : null });
  }
  return parts;
}

/** The quantity of a part on a line: per bundle x the line's quantity, to three decimals (like a line's quantity). */
export function partQuantity(perBundle: number, lineQuantity: number): number {
  return Math.round(perBundle * lineQuantity * 1000) / 1000;
}

/**
 * The parts' sum, for reference only: each part's price in the bundle's own VAT mode at the given rate
 * (productPriceFor), times its quantity, half up to the agora. The bundle keeps its own price.
 */
export function partsReferenceSum(parts: { quantity: number; price: ProductPrice }[], bundleIncludesVat: boolean, rateBp: number): number {
  let sum = 0;
  for (const part of parts) {
    const unit = productPriceFor(part.price, bundleIncludesVat, rateBp);
    // quantities have at most three decimals: work in thousandths so the half-up rounding is exact
    const thousandths = Math.round(part.quantity * 1000);
    sum += Math.floor((unit * thousandths + 500) / 1000);
  }
  return sum;
}

/**
 * The parts of an itemised bundle line as plain text, one per line ("· 2 ק\"ג מזגן"), for the PDFs; null when the line
 * shows no parts. Quantities are per bundle x the line's quantity; never a price.
 */
export function bundlePartsText(display: BundleDisplay | null, parts: BundlePartSnapshot[], lineQuantity: number): string | null {
  if (display !== "itemised" || parts.length === 0) return null;
  return parts
    .map((part) => `· ${formatNumber(partQuantity(part.quantity, lineQuantity))}${part.unitName ? ` ${part.unitName}` : ""} ${part.name}`)
    .join("\n");
}

/**
 * The notice after copying a bundle whose parts were not all copied (?parts_skipped=N; -1 = the parts could not be read).
 * The reason is named only when every left-out part was refused as inactive or archived (?parts_why=inactive).
 */
export function partsSkippedNotice(value: string | string[] | undefined, why?: string | string[]): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || !/^-?\d{1,3}$/.test(raw)) return null;
  const count = Number(raw);
  const inactive = (Array.isArray(why) ? why[0] : why) === "inactive";
  if (count === -1) return "לא הצלחנו להעתיק את רכיבי החבילה. אפשר להוסיף אותם כאן.";
  if (count === 1) return inactive ? "רכיב אחד לא הועתק, כי הוא לא פעיל או בארכיון." : "רכיב אחד לא הועתק.";
  if (count > 1) return inactive ? `${count} רכיבים לא הועתקו, כי הם לא פעילים או בארכיון.` : `${count} רכיבים לא הועתקו.`;
  return null;
}
