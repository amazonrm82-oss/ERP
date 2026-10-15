import { describe, expect, it } from "vitest";

import { IMPORT_TARGETS, suggestMapping } from "@/features/imports/fields";
import { findCategory, parsePrice, parseProductRow, parseYesNo, splitCategoryPath, type CategoryRef } from "@/features/imports/product-rows";
import { PRODUCT_EXPORT_HEADER, plainShekels, productExportRows } from "@/features/products/export-table";

describe("product import rows (PRD-05)", () => {
  it("takes a full row in Hebrew", () => {
    const row = parseProductRow(
      {
        name: "ייעוץ שעתי",
        description: "שעת ייעוץ",
        sku: " A-1 ",
        category: "שירותים",
        kind: "שירות",
        unit: "שעה",
        price: "₪1,250.50",
        price_includes_vat: "כן",
        vat_kind: 'חייב במע"מ',
        billing: "חודשי",
        duration_minutes: "60",
        barcode: "729000",
        is_active: "לא",
      },
      false,
    );
    expect(row).toEqual({
      values: {
        name: "ייעוץ שעתי",
        description: "שעת ייעוץ",
        sku: "A-1",
        barcode: "729000",
        kind: "service",
        vat_kind: "taxable",
        billing: "monthly",
        price_agorot: 125050,
        price_includes_vat: true,
        duration_minutes: 60,
        is_active: false,
      },
      category: "שירותים",
      unit: "שעה",
    });
  });

  it("fills the defaults: a taxable one-time active product, price mode from the business", () => {
    const row = parseProductRow({ name: "כיסא" }, true);
    expect(row).toMatchObject({
      values: { kind: "product", vat_kind: "taxable", billing: "one_time", price_agorot: 0, price_includes_vat: true, is_active: true, sku: null },
      category: null,
      unit: null,
    });
  });

  it("an exempt or zero-rate product never says 'including VAT'", () => {
    expect(parseProductRow({ name: "ספר", vat_kind: "פטור", price_includes_vat: "כן" }, true)).toMatchObject({ values: { vat_kind: "exempt", price_includes_vat: false } });
    expect(parseProductRow({ name: "יצוא", vat_kind: "שיעור אפס" }, true)).toMatchObject({ values: { vat_kind: "zero_rate", price_includes_vat: false } });
    expect(parseProductRow({ name: "x", vat_kind: "zero_rate" }, false)).toMatchObject({ values: { vat_kind: "zero_rate" } });
  });

  it("refuses what it cannot read, with a message", () => {
    expect(parseProductRow({}, false)).toBe("חסר שם למוצר.");
    expect(parseProductRow({ name: "x".repeat(201) }, false)).toMatch(/השם ארוך/);
    expect(parseProductRow({ name: "x", sku: "s".repeat(65) }, false)).toMatch(/המק"ט ארוך/);
    expect(parseProductRow({ name: "x", kind: "רכב" }, false)).toMatch(/הסוג "רכב"/);
    expect(parseProductRow({ name: "x", vat_kind: "חצי" }, false)).toMatch(/סוג המע"מ/);
    expect(parseProductRow({ name: "x", billing: "שבועי" }, false)).toMatch(/אופן החיוב/);
    expect(parseProductRow({ name: "x", price: "abc" }, false)).toMatch(/המחיר "abc"/);
    expect(parseProductRow({ name: "x", price: "-5" }, false)).toMatch(/המחיר/);
    expect(parseProductRow({ name: "x", price: "10000000001" }, false)).toBe("המחיר גבוה מדי.");
    expect(parseProductRow({ name: "x", duration_minutes: "0" }, false)).toMatch(/משך/);
    expect(parseProductRow({ name: "x", duration_minutes: "1441" }, false)).toMatch(/משך/);
    expect(parseProductRow({ name: "x", is_active: "אולי" }, false)).toMatch(/פעיל/);
    expect(parseProductRow({ name: "x", price_includes_vat: "אולי" }, false)).toMatch(/כולל מע"מ/);
  });

  it("reads prices as typed and as Excel stores them", () => {
    expect(parsePrice("1250")).toBe(125000);
    expect(parsePrice("1,250.5")).toBe(125050);
    expect(parsePrice("₪ 99.99")).toBe(9999);
    expect(parsePrice("99.99000000000001")).toBe(9999);
    expect(parsePrice("12.345")).toBeNull();
    expect(parsePrice("1.2.3")).toBeNull();
  });

  it("reads yes and no", () => {
    for (const yes of ["כן", "TRUE", "yes", "1", "פעיל", 'כולל מע"מ']) expect(parseYesNo(yes), yes).toBe(true);
    for (const no of ["לא", "false", "No", "0", "לא פעיל", 'לפני מע"מ']) expect(parseYesNo(no), no).toBe(false);
    expect(parseYesNo("אולי")).toBeUndefined();
  });

  it("knows the kinds, VAT kinds and billings by their keys and labels", () => {
    expect(parseProductRow({ name: "x", kind: "subscription", billing: "yearly", vat_kind: "exempt" }, false)).toMatchObject({
      values: { kind: "subscription", billing: "yearly", vat_kind: "exempt" },
    });
    expect(parseProductRow({ name: "x", kind: "חבילה", billing: "חד-פעמי", vat_kind: 'מע"מ בשיעור אפס' }, false)).toMatchObject({
      values: { kind: "bundle", billing: "one_time", vat_kind: "zero_rate" },
    });
  });
});

describe("categories by name (PRD-05)", () => {
  const categories: CategoryRef[] = [
    { id: "t1", parentId: null, name: "ריהוט" },
    { id: "c1", parentId: "t1", name: "כיסאות" },
    { id: "t2", parentId: null, name: "משרד" },
    { id: "c2", parentId: "t2", name: "כיסאות" },
    { id: "c3", parentId: "t2", name: "שולחנות" },
  ];

  it("splits a path", () => {
    expect(splitCategoryPath("ריהוט > כיסאות")).toEqual(["ריהוט", "כיסאות"]);
    expect(splitCategoryPath("ריהוט › כיסאות")).toEqual(["ריהוט", "כיסאות"]);
    expect(splitCategoryPath("ריהוט/כיסאות")).toEqual(["ריהוט", "כיסאות"]);
  });

  it("finds a top category, a path, and a unique subcategory; says when it is missing or ambiguous", () => {
    expect(findCategory(categories, " ריהוט ")).toEqual({ id: "t1" });
    expect(findCategory(categories, "משרד > כיסאות")).toEqual({ id: "c2" });
    expect(findCategory(categories, "שולחנות")).toEqual({ id: "c3" });
    expect(findCategory(categories, "כיסאות")).toBe("ambiguous");
    expect(findCategory(categories, "תאורה")).toBe("missing");
    expect(findCategory(categories, "תאורה > מנורות")).toBe("missing-path");
    expect(findCategory(categories, "א > ב > ג")).toBe("missing-path");
  });
});

describe("product export (PRD-05)", () => {
  it("writes plain prices", () => {
    expect(plainShekels(0)).toBe("0.00");
    expect(plainShekels(125050)).toBe("1250.50");
    expect(plainShekels(5)).toBe("0.05");
  });

  it("an exported file maps back onto every product column and reads back to the same product", () => {
    const mapping = suggestMapping([...PRODUCT_EXPORT_HEADER], IMPORT_TARGETS.product);
    expect(mapping).toEqual([
      "name",
      "description",
      "sku",
      "category",
      "kind",
      "unit",
      "price",
      "price_includes_vat",
      "vat_kind",
      "billing",
      "duration_minutes",
      "barcode",
      "is_active",
      "",
    ]);
    const [cells] = productExportRows(
      [
        {
          id: "p1",
          name: "ייעוץ",
          description: null,
          sku: "C-1",
          categoryId: "c1",
          kind: "service",
          unitId: "u1",
          priceAgorot: 125050,
          priceIncludesVat: true,
          vatKind: "taxable",
          billing: "monthly",
          durationMinutes: 45,
          barcode: null,
          isActive: true,
          archivedAt: null,
        },
      ],
      [
        { id: "t1", parentId: null, name: "שירותים", position: 0 },
        { id: "c1", parentId: "t1", name: "ייעוץ", position: 0 },
      ],
      [{ id: "u1", name: "שעה", position: 0 }],
    );
    const raw: Record<string, string> = {};
    mapping.forEach((key, i) => {
      if (key && cells[i] !== "") raw[key] = cells[i];
    });
    expect(parseProductRow(raw, false)).toEqual({
      values: {
        name: "ייעוץ",
        description: null,
        sku: "C-1",
        barcode: null,
        kind: "service",
        vat_kind: "taxable",
        billing: "monthly",
        price_agorot: 125050,
        price_includes_vat: true,
        duration_minutes: 45,
        is_active: true,
      },
      category: "שירותים › ייעוץ",
      unit: "שעה",
    });
  });
});
