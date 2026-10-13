import { describe, expect, it } from "vitest";

import { categoryLabel, categoryOptions, categoryTree, categoryWithChildren, type ProductCategory } from "@/features/products/lists";

const c = (id: string, name: string, parentId: string | null, position = 0): ProductCategory => ({ id, name, parentId, position });

const categories = [c("b", "שירותים", null, 1), c("a", "מוצרים", null, 0), c("b2", "תמיכה", "b", 1), c("b1", "ייעוץ", "b", 0), c("x", "יתום", "missing", 0)];

describe("product categories (PRD-04)", () => {
  it("builds a two-level tree in each level's order", () => {
    const tree = categoryTree(categories);
    // same position: by name ("יתום" before "מוצרים")
    expect(tree.map((t) => t.id)).toEqual(["x", "a", "b"]);
    expect(tree.find((t) => t.id === "b")!.children.map((child) => child.id)).toEqual(["b1", "b2"]);
  });

  it("labels a subcategory with its parent", () => {
    expect(categoryLabel(categories, "b1")).toBe("שירותים › ייעוץ");
    expect(categoryLabel(categories, "a")).toBe("מוצרים");
    expect(categoryLabel(categories, null)).toBeNull();
    expect(categoryLabel(categories, "nope")).toBeNull();
  });

  it("lists picker options in tree order", () => {
    expect(categoryOptions(categories).map((o) => [o.id, o.depth])).toEqual([
      ["x", 0],
      ["a", 0],
      ["b", 0],
      ["b1", 1],
      ["b2", 1],
    ]);
  });

  it("a top category filters with its subcategories", () => {
    expect(categoryWithChildren(categories, "b")).toEqual(["b", "b2", "b1"]);
    expect(categoryWithChildren(categories, "b1")).toEqual(["b1"]);
  });
});
