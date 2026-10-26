import { describe, expect, it } from "vitest";

import { chequesAddUp, priceSale, quickSaleBody, quickSaleDealName, splitEvenly, quickSaleItemsSchema, type SaleProduct, type SalePricing } from "@/features/quick-sale/sale";
import { createItems } from "@/features/shell/nav";

// GAP-08: the quick sale's pure rules (prices as deal lines, the total with VAT, the RPC's JSON) and its "+" menu entry.

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const LIST = "33333333-3333-4333-8333-333333333333";

const product = (over: Partial<SaleProduct> = {}): SaleProduct => ({
  id: P1,
  name: "שיעור",
  priceAgorot: 10000,
  priceIncludesVat: false,
  vatKind: "taxable",
  billing: "one_time",
  offerable: true,
  ...over,
});
const pricing = (over: Partial<SalePricing> = {}): SalePricing => ({
  day: "2026-10-26",
  includesVat: false,
  conversionRateBp: 1800,
  documentRateBp: 1800,
  list: null,
  ...over,
});

describe("priceSale (GAP-08)", () => {
  it("prices each item as a deal line and totals with VAT", () => {
    const products = new Map([
      [P1, product()],
      [P2, product({ id: P2, name: "ספר", vatKind: "exempt", priceAgorot: 5000 })],
    ]);
    const result = priceSale(
      [
        { productId: P1, quantity: 2 },
        { productId: P2, quantity: 1 },
      ],
      products,
      pricing(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines.map((l) => [l.unitPriceAgorot, l.vatExempt, l.source])).toEqual([
      [10000, false, "product"],
      [5000, true, "product"],
    ]);
    // 200.00 taxable + 18% + 50.00 exempt
    expect(result.totals.totalAgorot).toBe(28600);
    expect(result.totals.netTotalAgorot).toBe(25000);
  });

  it("carries a price typed with VAT into a business that prices before VAT", () => {
    const result = priceSale([{ productId: P1, quantity: 1 }], new Map([[P1, product({ priceAgorot: 11800, priceIncludesVat: true })]]), pricing());
    expect(result.ok && result.lines[0].unitPriceAgorot).toBe(10000);
    expect(result.ok && result.totals.totalAgorot).toBe(11800);
  });

  it("takes the customer's price list", () => {
    const list = {
      id: LIST,
      name: "מחירון",
      isActive: true,
      validFrom: null,
      validTo: null,
      lines: [{ id: "x", productId: P1, minQuantity: 1, priceAgorot: 8000, discountBp: null, priceIncludesVat: false }],
    };
    const result = priceSale([{ productId: P1, quantity: 1 }], new Map([[P1, product()]]), pricing({ list }));
    expect(result.ok && result.lines[0]).toMatchObject({ unitPriceAgorot: 8000, source: "price_list", priceListId: LIST });
  });

  it("says why it cannot price", () => {
    const items = [{ productId: P1, quantity: 1 }];
    expect(priceSale(items, new Map([[P1, product()]]), pricing({ documentRateBp: null }))).toEqual({ ok: false, reason: "vat_unknown" });
    expect(priceSale(items, new Map(), pricing())).toMatchObject({ ok: false, reason: "product" });
    expect(priceSale(items, new Map([[P1, product({ offerable: false })]]), pricing())).toMatchObject({ ok: false, reason: "product" });
    expect(priceSale(items, new Map([[P1, product({ billing: "monthly" })]]), pricing())).toMatchObject({ ok: false, reason: "recurring" });
  });

  it("a business that charges no VAT pays the net", () => {
    const result = priceSale([{ productId: P1, quantity: 3 }], new Map([[P1, product()]]), pricing({ documentRateBp: 0 }));
    expect(result.ok && result.totals.totalAgorot).toBe(30000);
  });
});

describe("quick sale input and body (GAP-08)", () => {
  it("accepts 1..50 items with up to 3 decimals", () => {
    expect(quickSaleItemsSchema.safeParse([]).success).toBe(false);
    expect(quickSaleItemsSchema.safeParse([{ productId: P1, quantity: 1.5 }]).success).toBe(true);
    expect(quickSaleItemsSchema.safeParse([{ productId: P1, quantity: 1.2345 }]).success).toBe(false);
    expect(quickSaleItemsSchema.safeParse([{ productId: P1, quantity: 0 }]).success).toBe(false);
    expect(quickSaleItemsSchema.safeParse(Array.from({ length: 51 }, () => ({ productId: P1, quantity: 1 }))).success).toBe(false);
  });

  it("builds the JSON public.quick_sale takes", () => {
    const priced = priceSale([{ productId: P1, quantity: 1 }], new Map([[P1, product()]]), pricing());
    if (!priced.ok) throw new Error("not priced");
    const body = quickSaleBody(
      { newContact: { firstName: "דנה", lastName: null, phone: "050-1234567" } },
      priced.lines,
      { method: "credit", installments: 3, reference: null, cheques: null },
      { docType: "receipt", number: "77" },
      11800,
      "עסקה ממכירה מהירה, 26.10.2026",
    );
    expect(body).toEqual({
      deal_name: "עסקה ממכירה מהירה, 26.10.2026",
      new_contact: { first_name: "דנה", last_name: null, phone: "050-1234567" },
      lines: [{ product_id: P1, quantity: 1, unit_price_agorot: 10000, price_source: "product", price_list_id: null }],
      payment: { method: "credit", installments: 3, reference: null, cheques: null },
      document: { doc_type: "receipt", number: "77" },
      expected_total_agorot: 11800,
    });
    const cash = quickSaleBody({ contactId: P2 }, priced.lines, { method: "cash", installments: 4, reference: "r", cheques: null }, null, 11800, "x");
    expect(cash).toMatchObject({ contact_id: P2, payment: { method: "cash", installments: null }, document: null });
    expect("new_contact" in cash).toBe(false);
  });
});

describe("cheques (GAP-08, PAY-04)", () => {
  it("splits a total evenly to the agora, the extra agorot on the first cheques", () => {
    expect(splitEvenly(10000, 3)).toEqual([3334, 3333, 3333]);
    expect(splitEvenly(10002, 4)).toEqual([2501, 2501, 2500, 2500]);
    expect(splitEvenly(36, 36)).toEqual(Array(36).fill(1));
    expect(splitEvenly(2, 3)).toEqual([]);
    for (const [total, n] of [[123457, 7], [99999, 36], [1, 1]]) expect(splitEvenly(total, n).reduce((a, b) => a + b, 0)).toBe(total);
  });

  it("the cheques must add up exactly to the total", () => {
    expect(chequesAddUp([{ amount_agorot: 5000 }, { amount_agorot: 6800 }], 11800)).toBe(true);
    expect(chequesAddUp([{ amount_agorot: 5000 }, { amount_agorot: 6799 }], 11800)).toBe(false);
  });
});

describe("the deal's name (GAP-08)", () => {
  it("is the business's word, the quick sale and the day, never the customer's name", () => {
    expect(quickSaleDealName("עסקה", "2026-10-26")).toBe("עסקה ממכירה מהירה, 26.10.2026");
    expect(quickSaleDealName("פרויקט", "2026-01-05")).toBe("פרויקט ממכירה מהירה, 05.01.2026");
  });
});

describe('the "+" menu (GAP-08)', () => {
  it("offers the quick sale only when asked", () => {
    expect(createItems("org").some((item) => item.key === "quick_sale")).toBe(false);
    const items = createItems("org", undefined, undefined, { quickSale: true });
    expect(items.at(-1)).toMatchObject({ key: "quick_sale", label: "מכירה מהירה", href: "/o/org/payments/quick-sale" });
  });
});
