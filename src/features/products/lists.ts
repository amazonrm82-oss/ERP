import { z } from "zod";

import { optionalId, requiredText } from "@/lib/validation";

// PRD-04: the managed lists a product picks from: categories (two levels) and units of measure.

export const CATEGORY_NAME_MAX = 80;
export const UNIT_NAME_MAX = 30;
// the database refuses more (triggers product_categories_check, product_units_cap)
export const CATEGORIES_PER_ORG = 200;
export const UNITS_PER_ORG = 50;

// every organization starts with these and renames or deletes them freely; the database seeds them
// (app.seed_product_lists); tests/db/96-product-lists.test.ts keeps the two equal
export const DEFAULT_PRODUCT_UNITS = ["יחידה", "שעה", "יום", "חודש", 'מ"ר', 'ק"ג', "ליטר", "מטר"] as const;
export const DEFAULT_PRODUCT_CATEGORIES = ["כללי"] as const;

export const categorySchema = z.object({
  name: requiredText(CATEGORY_NAME_MAX, "יש להזין שם לקטגוריה.", `השם ארוך מדי (עד ${CATEGORY_NAME_MAX} תווים).`),
  // empty = a top category
  parent_id: optionalId,
});

export const unitSchema = z.object({
  name: requiredText(UNIT_NAME_MAX, "יש להזין יחידת מידה.", `השם ארוך מדי (עד ${UNIT_NAME_MAX} תווים).`),
});

export type ProductCategory = { id: string; parentId: string | null; name: string; position: number };
export type ProductUnit = { id: string; name: string; position: number };

export type CategoryNode = ProductCategory & { children: ProductCategory[] };

/**
 * The categories as a tree of two levels, each level in its own order. A
 * subcategory whose parent is missing (cannot happen in the database, which
 * sets it to null) is shown as a top category.
 */
export function categoryTree(categories: readonly ProductCategory[]): CategoryNode[] {
  const byOrder = (a: ProductCategory, b: ProductCategory) => a.position - b.position || a.name.localeCompare(b.name, "he");
  const tops = categories.filter((c) => c.parentId === null || !categories.some((p) => p.id === c.parentId)).sort(byOrder);
  return tops.map((top) => ({ ...top, children: categories.filter((c) => c.parentId === top.id).sort(byOrder) }));
}

/** "ראשית › משנית", or the name of a top category. */
export function categoryLabel(categories: readonly ProductCategory[], id: string | null): string | null {
  if (!id) return null;
  const category = categories.find((c) => c.id === id);
  if (!category) return null;
  const parent = category.parentId ? categories.find((c) => c.id === category.parentId) : null;
  return parent ? `${parent.name} › ${category.name}` : category.name;
}

/** The options of a category picker, in tree order: top categories, each followed by its subcategories. */
export function categoryOptions(categories: readonly ProductCategory[]): Array<{ id: string; label: string; depth: 0 | 1 }> {
  return categoryTree(categories).flatMap((top) => [
    { id: top.id, label: top.name, depth: 0 as const },
    ...top.children.map((child) => ({ id: child.id, label: `${top.name} › ${child.name}`, depth: 1 as const })),
  ]);
}

/** A category and its subcategories: filtering by a top category also finds the products of its subcategories. */
export function categoryWithChildren(categories: readonly ProductCategory[], id: string): string[] {
  return [id, ...categories.filter((c) => c.parentId === id).map((c) => c.id)];
}
