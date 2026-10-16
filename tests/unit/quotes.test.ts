import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { defaultQuoteTitle, NO_VAT_REASONS, noVatText, QUOTE_STATUSES, quoteHeaderSchema, quoteLineSchema } from "@/features/quotes/schema";
import { groupSubtotals, isCounted, moveBefore, quoteTotals, type QuoteLineAmounts } from "@/features/quotes/totals";

const migration = (() => {
  const dir = path.join(process.cwd(), "supabase/migrations");
  return readFileSync(path.join(dir, readdirSync(dir).find((f) => f.endsWith("_quotes.sql"))!), "utf8");
})();

const item = (id: string, price: number, extra: Partial<QuoteLineAmounts> = {}): QuoteLineAmounts => ({
  id,
  kind: "item",
  quantity: 1,
  unitPriceAgorot: price,
  discountBp: null,
  discountAgorot: null,
  vatExempt: false,
  isOptional: false,
  optionalSelected: false,
  ...extra,
});
const group = (id: string): QuoteLineAmounts => ({ ...item(id, 0), kind: "group" });

describe("quote lists mirror the migration", () => {
  it("statuses and no-VAT reasons are the check constraints' values", () => {
    const statuses = migration.match(/status in \(([^)]*)\)/)?.[1];
    expect(statuses && [...statuses.matchAll(/'([a-z]+)'/g)].map((m) => m[1])).toEqual([...QUOTE_STATUSES]);
    const reasons = migration.match(/no_vat_reason in \(([^)]*)\)/)?.[1];
    expect(reasons && [...reasons.matchAll(/'([a-z]+)'/g)].map((m) => m[1])).toEqual([...NO_VAT_REASONS]);
  });
});

describe("live totals of a quote (QUO-02, the one totals rule)", () => {
  it("acceptance 4.6: 100 before VAT x 3, 10% off = 270.00, VAT 48.60, total 318.60", () => {
    const result = quoteTotals({
      lines: [item("a", 10000, { quantity: 3, discountBp: 1000 })],
      rateBp: 1800,
      noVat: false,
      pricesIncludeVat: false,
      discountBp: null,
      discountAgorot: null,
    });
    expect(result.ok && result.totals).toMatchObject({ netTotalAgorot: 27000, vatAgorot: 4860, totalAgorot: 31860 });
  });

  it("counts optional lines only while selected, never group headings; no VAT with a reason; no status = no VAT line", () => {
    const lines = [group("g"), item("a", 10000), item("b", 5000, { isOptional: true }), item("c", 2000, { isOptional: true, optionalSelected: true })];
    expect(lines.map(isCounted)).toEqual([false, true, false, true]);
    const base = { lines, rateBp: 1800, noVat: false, pricesIncludeVat: false, discountBp: null, discountAgorot: null };
    expect(quoteTotals(base).ok && quoteTotals(base)).toMatchObject({ totals: { netTotalAgorot: 12000, vatAgorot: 2160 } });
    const noVat = quoteTotals({ ...base, noVat: true });
    expect(noVat.ok && noVat.totals).toMatchObject({ vatAgorot: 0, totalAgorot: 12000 });
    const unknown = quoteTotals({ ...base, rateBp: null });
    expect(unknown.ok && unknown.totals.vatAgorot).toBe(0);
    const discounted = quoteTotals({ ...base, discountBp: 1000 });
    expect(discounted.ok && discounted.totals).toMatchObject({ documentDiscountAgorot: 1200, netTotalAgorot: 10800, vatAgorot: 1944 });
    expect(quoteTotals({ ...base, discountAgorot: 999999 }).ok).toBe(false);
  });

  it("sums each group's counted lines up to the next heading", () => {
    const sums = groupSubtotals([
      { id: "x", kind: "item", isOptional: false, optionalSelected: false, totalAgorot: 100 },
      { id: "g1", kind: "group", isOptional: false, optionalSelected: false, totalAgorot: 0 },
      { id: "a", kind: "item", isOptional: false, optionalSelected: false, totalAgorot: 300 },
      { id: "b", kind: "item", isOptional: true, optionalSelected: false, totalAgorot: 900 },
      { id: "g2", kind: "group", isOptional: false, optionalSelected: false, totalAgorot: 0 },
    ]);
    expect([...sums]).toEqual([
      ["g1", 300],
      ["g2", 0],
    ]);
  });

  it("a drag puts the line before its target, or last", () => {
    expect(moveBefore(["a", "b", "c", "d"], "d", "b")).toEqual(["a", "d", "b", "c"]);
    expect(moveBefore(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
    expect(moveBefore(["a", "b", "c"], "b", "b")).toEqual(["a", "b", "c"]);
    expect(moveBefore(["a", "b"], "z", "a")).toEqual(["a", "b"]);
  });
});

describe("quote forms", () => {
  it("'other' needs its reason; the choice is kept when the form does not show it", () => {
    const base = { title: "הצעה", valid_until: "", notes: "", terms: "", discount_kind: "", discount: "" };
    expect(quoteHeaderSchema.safeParse({ ...base, no_vat_shown: "1", no_vat_reason: "other", no_vat_note: "" }).success).toBe(false);
    const other = quoteHeaderSchema.safeParse({ ...base, no_vat_shown: "1", no_vat_reason: "other", no_vat_note: "פטור מיוחד" });
    expect(other.success && other.data.noVat).toEqual({ reason: "other", note: "פטור מיוחד" });
    const eilat = quoteHeaderSchema.safeParse({ ...base, no_vat_shown: "1", no_vat_reason: "eilat", no_vat_note: "לא נשמר" });
    expect(eilat.success && eilat.data.noVat).toEqual({ reason: "eilat", note: null });
    const off = quoteHeaderSchema.safeParse({ ...base, no_vat_shown: "1", no_vat_reason: "" });
    expect(off.success && off.data.noVat).toEqual({ reason: null, note: null });
    const hidden = quoteHeaderSchema.safeParse(base);
    expect(hidden.success && hidden.data.noVat).toBeUndefined();
    expect(noVatText("abroad", null)).toBe('הצעה בלי מע"מ: לקוח בחו"ל');
  });

  it("an optional line is preselected only when it is optional", () => {
    const base = { product_id: "", name: "שורה", description: "", quantity: "1", unit_price: "10", discount_kind: "", discount: "", billing: "" };
    const plain = quoteLineSchema.safeParse({ ...base, optional_selected: "on" });
    expect(plain.success && [plain.data.isOptional, plain.data.optionalSelected]).toEqual([false, false]);
    const optional = quoteLineSchema.safeParse({ ...base, is_optional: "on", optional_selected: "on" });
    expect(optional.success && [optional.data.isOptional, optional.data.optionalSelected]).toEqual([true, true]);
  });

  it("titles a new quote after its deal or contact", () => {
    expect(defaultQuoteTitle("שיפוץ מטבח")).toBe("הצעת מחיר: שיפוץ מטבח");
    expect(defaultQuoteTitle("  ")).toBe("הצעת מחיר");
    expect(Array.from(defaultQuoteTitle("א".repeat(400))).length).toBe(200);
  });
});
