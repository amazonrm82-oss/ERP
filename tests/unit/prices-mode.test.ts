import { describe, expect, it } from "vitest";

import { documentPricesIncludeVat, pricesModeLabel } from "@/features/tax/prices";
import { pricesModeSchema } from "@/features/tax/schema";

/** TAX-04: prices before or including VAT, per organization and per document. */
describe("prices mode", () => {
  it("a document takes the organization's setting unless it chose for itself", () => {
    expect(documentPricesIncludeVat(null)).toBe(false);
    expect(documentPricesIncludeVat(undefined)).toBe(false);
    expect(documentPricesIncludeVat(true)).toBe(true);
    expect(documentPricesIncludeVat(true, false)).toBe(false);
    expect(documentPricesIncludeVat(false, true)).toBe(true);
    expect(documentPricesIncludeVat(false, null)).toBe(false);
  });

  it("the form takes net or gross only", () => {
    expect(pricesModeSchema.parse({ prices_mode: "gross" })).toEqual({ prices_include_vat: true });
    expect(pricesModeSchema.parse({ prices_mode: "net" })).toEqual({ prices_include_vat: false });
    expect(pricesModeSchema.safeParse({ prices_mode: "x" }).success).toBe(false);
    expect(pricesModeSchema.safeParse({ prices_mode: null }).success).toBe(false);
    expect(pricesModeLabel(true)).toBe('כולל מע"מ');
    expect(pricesModeLabel(false)).toBe('לפני מע"מ');
  });
});
