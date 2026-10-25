import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CATEGORY_PICKS_VALUE,
  coveredCategoryIds,
  formProductsFrom,
  MAX_FORM_CATEGORIES,
  orderedFormCategories,
  pickedCategoryIds,
  productOfferRefusal,
  PRODUCTS_ALL_OVER,
  PRODUCTS_PICK_OVER,
  initialProductPicks,
  MAX_FORM_PRODUCTS,
  mergeFormProductOptions,
  pickedProductIds,
  PRODUCT_PICKS_VALUE,
  productInput,
  productPicksValue,
} from "@/features/intake/product";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

const migration = readdirSync(join(process.cwd(), "supabase/migrations"))
  .filter((f) => f.endsWith("_form_requested_product.sql"))
  .map((f) => readFileSync(join(process.cwd(), "supabase/migrations", f), "utf8"))[0];

/** LEAD-04 / CAP-08: the public form's product question. */
describe("requested product on the public form", () => {
  it("reads intake_form()'s products: id and name only, nothing else kept, an empty list is no question", () => {
    expect(formProductsFrom([{ id: A, name: "בדיקה", price: 100 }, { id: "x", name: "רע" }, { id: B, name: "" }, null, "x"])).toEqual([
      { id: A, name: "בדיקה" },
    ]);
    expect(formProductsFrom([])).toBeNull();
    expect(formProductsFrom(undefined)).toBeNull();
    expect(formProductsFrom({ id: A, name: "x" })).toBeNull();
  });

  it("accepts only an offered product; empty is none", () => {
    const offered = [{ id: A, name: "בדיקה" }];
    expect(productInput(A, offered)).toBe(A);
    expect(productInput(` ${A} `, offered)).toBe(A);
    expect(productInput("", offered)).toBeNull();
    expect(productInput(null, offered)).toBeNull();
    expect(productInput(B, offered)).toBe("invalid");
    expect(productInput("drop table", offered)).toBe("invalid");
  });

  it("keeps picked ids that are offerable, once each, up to the limit", () => {
    expect(pickedProductIds([A, B, A], new Set([A]))).toEqual([A]);
    const many = Array.from({ length: 150 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(pickedProductIds(many, new Set(many))).toHaveLength(MAX_FORM_PRODUCTS);
  });

  it("the limit is the migration's, for the offer and for the picked list", () => {
    expect(migration).toContain(`cardinality(product_ids) between 1 and ${MAX_FORM_PRODUCTS}`);
    expect(migration).toMatch(new RegExp(`limit ${MAX_FORM_PRODUCTS}\\n`));
  });

  it("keeps a stored pick the 500-product list left out, once, in the public form's order", () => {
    const listed = [
      { id: B, name: "בדיקה" },
      { id: A, name: "Apple" },
    ];
    const outside = { id: "33333333-3333-4333-8333-333333333333", name: "zebra" };
    const merged = mergeFormProductOptions(listed, [outside, { id: A, name: "Apple" }]);
    expect(merged.map((p) => p.id)).toEqual([A, outside.id, B]);
    // the same name orders by id
    expect(mergeFormProductOptions([{ id: B, name: "x" }, { id: A, name: "X" }], []).map((p) => p.id)).toEqual([A, B]);
  });

  it("after a failed save the ticks start from what was sent, else from the stored picks", () => {
    const sent = productPicksValue([B, "junk", A]);
    expect(sent).toBe(`${B},${A}`);
    expect(initialProductPicks({ [PRODUCT_PICKS_VALUE]: sent }, [A])).toEqual(new Set([B, A]));
    // everything unticked before the failure stays unticked
    expect(initialProductPicks({ [PRODUCT_PICKS_VALUE]: "" }, [A])).toEqual(new Set());
    expect(initialProductPicks(undefined, [A])).toEqual(new Set([A]));
    expect(initialProductPicks({ name: "x" }, null)).toEqual(new Set());
  });

  it("a picked top category covers its sub-categories; a sub-category covers only itself; unknown ids cover nothing", () => {
    const T = "44444444-4444-4444-8444-444444444444";
    const S = "55555555-5555-4555-8555-555555555555";
    const O = "66666666-6666-4666-8666-666666666666";
    const cats = [
      { id: T, name: "משקפיים", parentId: null },
      { id: S, name: "משקפי שמש", parentId: T },
      { id: O, name: "עדשות", parentId: null },
    ];
    expect(coveredCategoryIds([T], cats)).toEqual(new Set([T, S]));
    expect(coveredCategoryIds([S], cats)).toEqual(new Set([S]));
    expect(coveredCategoryIds([A], cats)).toEqual(new Set());
    expect(orderedFormCategories(cats).map((c) => [c.id, c.depth])).toEqual([
      [T, 0],
      [S, 1],
      [O, 0],
    ]);
    expect(pickedCategoryIds([T, T, A], new Set([T]))).toEqual([T]);
    const many = Array.from({ length: 80 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(pickedCategoryIds(many, new Set(many))).toHaveLength(MAX_FORM_CATEGORIES);
  });

  it("over 100 active products: 'all' and an over-100 pick are refused while the form asks (owner, 25 October 2026)", () => {
    expect(productOfferRefusal(true, true, 100)).toBeNull();
    expect(productOfferRefusal(true, true, 101)).toBe(PRODUCTS_ALL_OVER);
    expect(productOfferRefusal(true, false, 101)).toBe(PRODUCTS_PICK_OVER);
    expect(productOfferRefusal(false, true, 5000)).toBeNull();
    expect(migration).toContain("hint = 'form:products_over'");
    expect(migration).toMatch(new RegExp(`\\) > ${MAX_FORM_PRODUCTS} then`));
  });

  it("after a failed save the category ticks start from what was sent", () => {
    expect(initialProductPicks({ [CATEGORY_PICKS_VALUE]: A }, [B], CATEGORY_PICKS_VALUE)).toEqual(new Set([A]));
    expect(initialProductPicks(undefined, [B], CATEGORY_PICKS_VALUE)).toEqual(new Set([B]));
  });
});

