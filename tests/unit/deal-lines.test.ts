import { describe, expect, it } from "vitest";

import {
  conversionRateBp,
  pickCustomerList,
  dealLinesMode,
  dealLinesTotals,
  lineTotal,
  priceOnEdit,
  pulledPrice,
  type NamedPriceList,
} from "@/features/deal-lines/pricing";
import { dealLineSchema, priceSourceText, quantityField, quickProductSchema } from "@/features/deal-lines/schema";
import { documentTotals } from "@/features/tax/calc";

const product = { id: "p1", priceAgorot: 10000, priceIncludesVat: false, vatKind: "taxable" as const };
const list = (lines: NamedPriceList["lines"], terms: Partial<NamedPriceList> = {}): NamedPriceList => ({
  id: "l1",
  name: "סיטונאי",
  isActive: true,
  validFrom: null,
  validTo: null,
  lines,
  ...terms,
});
const tier = (minQuantity: number, priceAgorot: number | null, discountBp: number | null, priceIncludesVat = false) => ({
  id: `t${minQuantity}`,
  productId: "p1",
  minQuantity,
  priceAgorot,
  discountBp,
  priceIncludesVat,
});

describe("deal lines (DLI-01)", () => {
  it("acceptance 4.6: 100 before VAT x 3 with 10% off = 270.00, VAT 48.60, total 318.60", () => {
    const line = { quantity: 3, unitPriceAgorot: 10000, discountBp: 1000, discountAgorot: null, vatExempt: false };
    const one = lineTotal(line, false);
    expect(one.ok && one.totals.lines[0].totalAgorot).toBe(27000);
    const all = dealLinesTotals([line], 1800, false);
    expect(all.ok && [all.totals.netTotalAgorot, all.totals.vatAgorot, all.totals.totalAgorot]).toEqual([27000, 4860, 31860]);
  });

  it("a line's total is the line part of documentTotals with other lines around it", () => {
    const lines = [
      { quantity: 2.5, unitPriceAgorot: 3999, discountBp: 1250 },
      { quantity: 0.333, unitPriceAgorot: 1001, discountAgorot: 17 },
      { quantity: 7, unitPriceAgorot: 12345, vatExempt: true },
    ];
    for (const mode of [false, true]) {
      const doc = documentTotals(lines, { rateBp: 1800, pricesIncludeVat: mode });
      expect(doc.ok).toBe(true);
      lines.forEach((line, i) => {
        const one = lineTotal(line, mode);
        expect(one.ok && doc.ok && one.totals.lines[0].totalAgorot).toBe(doc.ok ? doc.totals.lines[i].totalAgorot : null);
      });
    }
  });

  it("without a known VAT rate the totals carry no VAT", () => {
    const all = dealLinesTotals([{ quantity: 1, unitPriceAgorot: 11800 }], null, true);
    expect(all.ok && [all.totals.vatAgorot, all.totals.totalAgorot]).toEqual([0, 11800]);
  });

  it("one VAT mode per deal: its first line's, else the business's", () => {
    expect(dealLinesMode([], true)).toBe(true);
    expect(dealLinesMode([{ priceIncludesVat: false }, { priceIncludesVat: true }], true)).toBe(false);
  });
});

describe("the price a product gets on a deal line (PL-03)", () => {
  describe("the customer's list, by the owner's order (contact, contact's company, deal's company)", () => {
    const day = "2026-10-14";
    const named = (id: string, terms: { isActive?: boolean; validFrom?: string | null; validTo?: string | null } = {}) => ({
      id,
      isActive: terms.isActive ?? true,
      validFrom: terms.validFrom ?? null,
      validTo: terms.validTo ?? null,
    });
    const contact = named("contact");
    const contactCompany = named("contact-company");
    const dealCompany = named("deal-company");

    it("takes the first one that is set", () => {
      expect(pickCustomerList([contact, contactCompany, dealCompany], day)?.id).toBe("contact");
      expect(pickCustomerList([null, contactCompany, dealCompany], day)?.id).toBe("contact-company");
      expect(pickCustomerList([null, null, null], day)).toBeNull();
    });

    it("a contact with no list, whose company has none, takes the deal's company's list", () => {
      expect(pickCustomerList([null, null, dealCompany], day)?.id).toBe("deal-company");
    });

    it("a deal without a contact takes its company's list", () => {
      expect(pickCustomerList([null, null, dealCompany], day)?.id).toBe("deal-company");
    });

    it("passes over a set list that is inactive, expired or not yet in force (falls through)", () => {
      expect(pickCustomerList([named("off", { isActive: false }), contactCompany, dealCompany], day)?.id).toBe("contact-company");
      expect(pickCustomerList([named("old", { validTo: "2026-10-13" }), named("soon", { validFrom: "2026-10-15" }), dealCompany], day)?.id).toBe("deal-company");
      expect(pickCustomerList([named("old", { validTo: "2026-10-13" }), null, null], day)).toBeNull();
      // the last valid day still counts
      expect(pickCustomerList([named("ends", { validTo: day }), dealCompany], day)?.id).toBe("ends");
    });
  });

  it("no list, or no fitting tier: the product's own price", () => {
    expect(pulledPrice(product, null, 3, "2026-10-14", false, 1800)).toEqual({ priceAgorot: 10000, source: "product", priceListId: null, priceListName: null });
    expect(pulledPrice(product, list([tier(10, 8000, null)]), 3, "2026-10-14", false, 1800).source).toBe("product");
  });

  it("quantity tiers of a list that is in force", () => {
    const l = list([tier(0, 9500, null), tier(10, null, 2000)]);
    expect(pulledPrice(product, l, 3, "2026-10-14", false, 1800)).toEqual({ priceAgorot: 9500, source: "price_list", priceListId: "l1", priceListName: "סיטונאי" });
    expect(pulledPrice(product, l, 10, "2026-10-14", false, 1800).priceAgorot).toBe(8000);
  });

  it("a list that is inactive or out of its dates is not used", () => {
    expect(pulledPrice(product, list([tier(0, 9500, null)], { isActive: false }), 1, "2026-10-14", false, 1800).source).toBe("product");
    expect(pulledPrice(product, list([tier(0, 9500, null)], { validTo: "2026-10-13" }), 1, "2026-10-14", false, 1800).source).toBe("product");
    expect(pulledPrice(product, list([tier(0, 9500, null)], { validFrom: "2026-10-14" }), 1, "2026-10-14", false, 1800).source).toBe("price_list");
  });

  it("carries the price into the deal's VAT mode", () => {
    // a list price including VAT on a deal priced before VAT: 11800 / 1.18
    expect(pulledPrice(product, list([tier(0, 11800, null, true)]), 1, "2026-10-14", false, 1800).priceAgorot).toBe(10000);
    // the product's price before VAT on a deal priced including VAT
    expect(pulledPrice(product, null, 1, "2026-10-14", true, 1800).priceAgorot).toBe(11800);
    // an exempt product's price is its net in both modes
    expect(pulledPrice({ ...product, vatKind: "exempt" }, null, 1, "2026-10-14", true, 1800).priceAgorot).toBe(10000);
  });

  it("the conversion rate: the document's, else the day's rate while the status is unknown", () => {
    const rates = [{ effectiveFrom: "2025-01-01", rateBp: 1800 }];
    expect(conversionRateBp({ kind: "none" }, rates, "2026-10-14")).toBe(0);
    expect(conversionRateBp({ kind: "rate", rateBp: 1700 }, rates, "2026-10-14")).toBe(1700);
    expect(conversionRateBp({ kind: "unknown", missing: "status" }, rates, "2026-10-14")).toBe(1800);
    expect(conversionRateBp({ kind: "unknown", missing: "rate" }, [], "2026-10-14")).toBe(0);
  });

  it("an edit keeps a typed price and re-pulls only an automatic one", () => {
    const auto = { unitPriceAgorot: 9500, quantity: 3, source: "price_list" as const, hasProduct: true };
    expect(priceOnEdit(auto, 9500, 3)).toBe("keep");
    expect(priceOnEdit(auto, 9500, 10)).toBe("pull");
    expect(priceOnEdit(auto, 9000, 10)).toBe("manual");
    expect(priceOnEdit(auto, null, 3)).toBe("pull");
    const typed = { ...auto, source: "manual" as const };
    expect(priceOnEdit(typed, 9500, 10)).toBe("keep");
    expect(priceOnEdit(typed, null, 10)).toBe("pull");
    const free = { ...typed, hasProduct: false };
    expect(priceOnEdit(free, null, 3)).toBe("missing");
    expect(priceOnEdit(free, 9500, 10)).toBe("keep");
  });

  it("names where a price came from", () => {
    expect(priceSourceText("price_list", "סיטונאי")).toBe("מחירון: סיטונאי");
    expect(priceSourceText("product", null)).toBe("מחיר המוצר");
    expect(priceSourceText("manual", null)).toBe("מחיר שהוקלד");
  });
});

describe("the line form", () => {
  const form = (values: Record<string, string>) =>
    dealLineSchema.safeParse({ product_id: "", description: "שורה", quantity: "1", unit_price: "", discount_kind: "", discount: "", ...values });

  it("reads quantities with up to three decimals", () => {
    expect(quantityField.safeParse("").data).toBe(1);
    expect(quantityField.safeParse("1.125").data).toBe(1.125);
    for (const bad of ["0", "1.2345", "-1", "abc", "1000001"]) expect(quantityField.safeParse(bad).success, bad).toBe(false);
  });

  it("an empty price stays empty (automatic), a typed one is agorot", () => {
    expect(form({}).data?.unitPriceAgorot).toBeNull();
    expect(form({ unit_price: "99.90" }).data?.unitPriceAgorot).toBe(9990);
    expect(form({ unit_price: "x" }).success).toBe(false);
  });

  it("a discount is a percentage or an amount", () => {
    expect(form({ discount_kind: "percent", discount: "10" }).data).toMatchObject({ discountBp: 1000, discountAgorot: null });
    expect(form({ discount_kind: "amount", discount: "50" }).data).toMatchObject({ discountBp: null, discountAgorot: 5000 });
    expect(form({ discount_kind: "percent", discount: "101" }).success).toBe(false);
    expect(form({ discount_kind: "amount", discount: "" }).success).toBe(false);
    expect(form({ discount_kind: "", discount: "10" }).data).toMatchObject({ discountBp: null, discountAgorot: null });
  });

  it("VAT exempt: the box's value only when the form showed it (a free line), else keep what is stored", () => {
    expect(form({}).data?.vatExempt).toBeNull();
    expect(form({ vat_exempt: "on" }).data?.vatExempt).toBeNull();
    expect(form({ vat_exempt_shown: "1" }).data?.vatExempt).toBe(false);
    expect(form({ vat_exempt_shown: "1", vat_exempt: "on" }).data?.vatExempt).toBe(true);
  });

  it("a quick product needs a name", () => {
    expect(quickProductSchema.safeParse({ name: "", sku: "", price: "10" }).success).toBe(false);
    expect(quickProductSchema.safeParse({ name: "מוצר", sku: "", price: "10" }).data).toEqual({ name: "מוצר", sku: null, price: 1000 });
  });
});
