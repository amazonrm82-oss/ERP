import { describe, expect, it } from "vitest";

import { documentTotals, documentVatRateBp, totalsErrorMessage, type TotalsLine, type TotalsOptions } from "@/features/tax/calc";
import { documentVat } from "@/features/tax/rates";

const NET_18: TotalsOptions = { rateBp: 1800, pricesIncludeVat: false };
const GROSS_18: TotalsOptions = { rateBp: 1800, pricesIncludeVat: true };

function totals(lines: TotalsLine[], options: TotalsOptions) {
  const result = documentTotals(lines, options);
  if (!result.ok) throw new Error(`unexpected error ${result.error} at ${String(result.line)}`);
  return result.totals;
}

/** TAX-05: worked examples. Amounts in agorot. */
describe("document totals", () => {
  it("SPEC 4.6: 100 NIS before VAT, quantity 3, line discount 10%: line 270.00, VAT 48.60, total 318.60", () => {
    const t = totals([{ quantity: 3, unitPriceAgorot: 10000, discountBp: 1000 }], NET_18);
    expect(t.lines[0]).toEqual({ amountAgorot: 30000, discountAgorot: 3000, totalAgorot: 27000, netAgorot: 27000, vatExempt: false });
    expect(t.netTotalAgorot).toBe(27000);
    expect(t.vatAgorot).toBe(4860);
    expect(t.totalAgorot).toBe(31860);
  });

  it("VAT is rounded once at document level, not per line", () => {
    // three lines of 0.10: per line 1.8 agorot would round to 2 each (6); on the sum 30 x 18% = 5.4 -> 5
    const t = totals([1, 2, 3].map(() => ({ quantity: 1, unitPriceAgorot: 10 })), NET_18);
    expect(t.taxableAgorot).toBe(30);
    expect(t.vatAgorot).toBe(5);
    expect(t.totalAgorot).toBe(35);
  });

  it("rounds half up to the agora", () => {
    // 1.25 x 18% = 22.5 agorot -> 23
    expect(totals([{ quantity: 1, unitPriceAgorot: 125 }], NET_18).vatAgorot).toBe(23);
    // 1.24 x 18% = 22.32 -> 22
    expect(totals([{ quantity: 1, unitPriceAgorot: 124 }], NET_18).vatAgorot).toBe(22);
    // quantity with decimals: 0.333 x 10.01 = 3.33333 -> 3.33; 1.5 hours x 99.99 = 149.985 -> 149.99
    expect(totals([{ quantity: 0.333, unitPriceAgorot: 1001 }], NET_18).lines[0].amountAgorot).toBe(333);
    expect(totals([{ quantity: 1.5, unitPriceAgorot: 9999 }], NET_18).lines[0].amountAgorot).toBe(14999);
    // a line discount of 12.5% on 0.99 = 12.375 agorot -> 12
    expect(totals([{ quantity: 1, unitPriceAgorot: 99, discountBp: 1250 }], NET_18).lines[0].discountAgorot).toBe(12);
  });

  it("the 17% -> 18% change: the same lines on each side of 1 January 2025", () => {
    const lines: TotalsLine[] = [{ quantity: 2, unitPriceAgorot: 50000 }];
    // the rate comes from the document's day (TAX-03); the calculation only takes it
    const rates = [
      { effectiveFrom: "2015-10-01", rateBp: 1700 },
      { effectiveFrom: "2025-01-01", rateBp: 1800 },
    ];
    const before = documentVatRateBp(documentVat(true, rates, "2024-12-31"));
    const after = documentVatRateBp(documentVat(true, rates, "2025-01-01"));
    expect([before, after]).toEqual([1700, 1800]);
    const t17 = totals(lines, { rateBp: before ?? -1, pricesIncludeVat: false });
    const t18 = totals(lines, { rateBp: after ?? -1, pricesIncludeVat: false });
    expect([t17.vatAgorot, t17.totalAgorot]).toEqual([17000, 117000]);
    expect([t18.vatAgorot, t18.totalAgorot]).toEqual([18000, 118000]);
    // including VAT: 1,170.00 at 17% is 1,000.00 + 170.00; the same 1,170.00 at 18% is 991.53 + 178.47
    expect(totals([{ quantity: 1, unitPriceAgorot: 117000 }], { rateBp: 1700, pricesIncludeVat: true })).toMatchObject({
      taxableAgorot: 100000,
      vatAgorot: 17000,
      totalAgorot: 117000,
    });
    expect(totals([{ quantity: 1, unitPriceAgorot: 117000 }], GROSS_18)).toMatchObject({ taxableAgorot: 99153, vatAgorot: 17847, totalAgorot: 117000 });
  });

  it("a business that charges no VAT gets rate 0 and no VAT; an unknown status gets no rate at all", () => {
    expect(documentVatRateBp(documentVat(false, [], "2026-10-13"))).toBe(0);
    expect(documentVatRateBp(documentVat(null, [], "2026-10-13"))).toBeNull();
    const net = totals([{ quantity: 3, unitPriceAgorot: 10000 }], { rateBp: 0, pricesIncludeVat: false });
    const gross = totals([{ quantity: 3, unitPriceAgorot: 10000 }], { rateBp: 0, pricesIncludeVat: true });
    for (const t of [net, gross]) {
      expect(t.vatAgorot).toBe(0);
      expect(t.totalAgorot).toBe(30000);
      expect(t.netTotalAgorot).toBe(30000);
    }
  });

  it("including VAT: the customer pays exactly what was typed; VAT is taken out of it once", () => {
    // 118.00 incl., quantity 3, 10% off: 318.60 = 270.00 + 48.60
    const t = totals([{ quantity: 3, unitPriceAgorot: 11800, discountBp: 1000 }], GROSS_18);
    expect(t).toMatchObject({ subtotalAgorot: 31860, taxableAgorot: 27000, vatAgorot: 4860, totalAgorot: 31860 });
    // 100.00 incl.: 84.75 + 15.25 (100 / 1.18 = 84.745..)
    expect(totals([{ quantity: 1, unitPriceAgorot: 10000 }], GROSS_18)).toMatchObject({ taxableAgorot: 8475, vatAgorot: 1525, totalAgorot: 10000 });
  });

  it("including VAT: line nets add up to the document's net (largest remainder, earlier line first)", () => {
    // three lines of 1.00 incl.: each is 0.8474..; floors 84+84+84 = 252, the net of 3.00 is 2.54, so two lines get one more
    const t = totals([1, 2, 3].map(() => ({ quantity: 1, unitPriceAgorot: 100 })), GROSS_18);
    expect(t.lines.map((line) => line.netAgorot)).toEqual([85, 85, 84]);
    expect(t.netSubtotalAgorot).toBe(254);
    expect(t.vatAgorot).toBe(46);
    expect(t.totalAgorot).toBe(300);
    // the larger remainder wins: 0.50 incl. = 42.37 (rem .37), 0.30 incl. = 25.42 (rem .42); net of 0.80 = 67.80 -> 68
    const u = totals([{ quantity: 1, unitPriceAgorot: 50 }, { quantity: 1, unitPriceAgorot: 30 }], GROSS_18);
    expect(u.lines.map((line) => line.netAgorot)).toEqual([42, 26]);
    expect(u.netSubtotalAgorot).toBe(68);
  });

  it("an exempt line carries no VAT, and the document discount is split in proportion before VAT", () => {
    const lines: TotalsLine[] = [
      { quantity: 1, unitPriceAgorot: 100000 },
      { quantity: 1, unitPriceAgorot: 50000, vatExempt: true },
    ];
    // 10% off 1,500.00 = 150.00: 100.00 from the taxable 1,000.00, 50.00 from the exempt 500.00
    const t = totals(lines, { ...NET_18, discountBp: 1000 });
    expect(t).toMatchObject({
      subtotalAgorot: 150000,
      documentDiscountAgorot: 15000,
      taxableAgorot: 90000,
      exemptAgorot: 45000,
      vatAgorot: 16200,
      totalAgorot: 151200,
    });
    // the same in the including mode: the exempt line has no VAT inside its price
    const g = totals(lines, { ...GROSS_18, discountAgorot: 15000 });
    // taxable gross 900.00 -> 762.71 + 137.29; exempt 450.00
    expect(g).toMatchObject({ taxableAgorot: 76271, vatAgorot: 13729, exemptAgorot: 45000, totalAgorot: 135000 });
    expect(g.netSubtotalAgorot - g.netDiscountAgorot).toBe(g.netTotalAgorot);
    // the line discount as a fixed amount
    expect(totals([{ quantity: 2, unitPriceAgorot: 5000, discountAgorot: 1000 }], NET_18).lines[0].totalAgorot).toBe(9000);
  });

  it("an optional rounding line to a whole shekel, after VAT", () => {
    const t = totals([{ quantity: 3, unitPriceAgorot: 10000, discountBp: 1000 }], { ...NET_18, roundToShekel: true });
    expect([t.totalBeforeRoundingAgorot, t.roundingAgorot, t.totalAgorot]).toEqual([31860, 40, 31900]);
    // 0.49 rounds down, 0.50 up
    expect(totals([{ quantity: 1, unitPriceAgorot: 10049 }], { rateBp: 0, pricesIncludeVat: false, roundToShekel: true }).roundingAgorot).toBe(-49);
    expect(totals([{ quantity: 1, unitPriceAgorot: 10050 }], { rateBp: 0, pricesIncludeVat: false, roundToShekel: true }).totalAgorot).toBe(10100);
    // VAT is not touched by the rounding line
    expect(t.vatAgorot).toBe(4860);
  });

  it("an empty document is all zeros", () => {
    const t = totals([], { ...NET_18, discountBp: 500, roundToShekel: true });
    expect([t.subtotalAgorot, t.vatAgorot, t.totalAgorot, t.documentDiscountAgorot]).toEqual([0, 0, 0, 0]);
  });

  it("refuses what it cannot compute, naming the line", () => {
    const bad: [TotalsLine[], TotalsOptions, string, number | null][] = [
      [[{ quantity: 0, unitPriceAgorot: 100 }], NET_18, "quantity", 0],
      [[{ quantity: 1, unitPriceAgorot: 1 }, { quantity: 0.0001, unitPriceAgorot: 100 }], NET_18, "quantity", 1],
      [[{ quantity: 1.0000000001, unitPriceAgorot: 100 }], NET_18, "quantity", 0],
      [[{ quantity: 2.0000000004, unitPriceAgorot: 100 }], NET_18, "quantity", 0],
      [[{ quantity: 1, unitPriceAgorot: -1 }], NET_18, "price", 0],
      [[{ quantity: 1, unitPriceAgorot: 1.5 }], NET_18, "price", 0],
      [[{ quantity: 1, unitPriceAgorot: 100, discountBp: 100, discountAgorot: 1 }], NET_18, "discount", 0],
      [[{ quantity: 1, unitPriceAgorot: 100, discountBp: 10001 }], NET_18, "discount", 0],
      [[{ quantity: 1, unitPriceAgorot: 100, discountAgorot: 101 }], NET_18, "discount_too_large", 0],
      [[{ quantity: 1000000, unitPriceAgorot: 100000000 }], NET_18, "amount", 0],
      [[{ quantity: 1, unitPriceAgorot: 100 }], { ...NET_18, discountAgorot: 101 }, "discount_too_large", null],
      [[{ quantity: 1, unitPriceAgorot: 100 }], { ...NET_18, discountAgorot: 1, discountBp: 1 }, "discount", null],
      [[], { rateBp: 10001, pricesIncludeVat: false }, "rate", null],
    ];
    for (const [lines, options, error, line] of bad) {
      expect(documentTotals(lines, options), error).toEqual({ ok: false, error, line });
      expect(totalsErrorMessage(error as never)).toMatch(/\S/);
    }
  });
});
