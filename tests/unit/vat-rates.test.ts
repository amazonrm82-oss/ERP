import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { documentVat, documentVatError, vatRateAt, vatRateLabel, type VatRate } from "@/features/tax/rates";
import { dbErrorMessage, VAT_BEFORE_TABLE } from "@/lib/errors";

const migration = readFileSync(join(process.cwd(), "supabase/migrations/20261006013700_vat_rates.sql"), "utf8");
// the seeded rows of the migration, so the mirror is tested on the real data
const RATES: VatRate[] = [...migration.matchAll(/\('(\d{4}-\d{2}-\d{2})', (\d+), '[^']*'\)/g)].map((m) => ({ effectiveFrom: m[1], rateBp: Number(m[2]) }));

// TAX-03: a document uses the rate of its own date
describe("VAT rates (TAX-03)", () => {
  it("the seed is 17% then 18% from 1 January 2025", () => {
    expect(RATES).toEqual([
      { effectiveFrom: "2015-10-01", rateBp: 1700 },
      { effectiveFrom: "2025-01-01", rateBp: 1800 },
    ]);
  });

  it("vatRateAt() mirrors app.vat_rate_at(), boundaries included", () => {
    expect(vatRateAt(RATES, "2024-12-31")).toBe(1700);
    expect(vatRateAt(RATES, "2025-01-01")).toBe(1800);
    expect(vatRateAt(RATES, "2015-10-01")).toBe(1700);
    expect(vatRateAt(RATES, "2015-09-30")).toBeNull();
    expect(vatRateAt(RATES, "not a day")).toBeNull();
    // order of the rows does not matter; a later change is a new row
    expect(vatRateAt([...RATES, { effectiveFrom: "2027-01-01", rateBp: 1900 }].reverse(), "2026-12-31")).toBe(1800);
    expect(vatRateAt([...RATES, { effectiveFrom: "2027-01-01", rateBp: 1900 }], "2027-01-01")).toBe(1900);
  });

  it("the SQL function picks the latest row on or before the day", () => {
    expect(migration).toMatch(/where r\.effective_from <= p_date\s+order by r\.effective_from desc\s+limit 1/);
  });

  it("labels", () => {
    expect(vatRateLabel(1800)).toBe("18%");
    expect(vatRateLabel(1750)).toBe("17.5%");
  });

  it("documentVat(): an exempt business has no VAT line; unknown is never a guess", () => {
    expect(documentVat(false, RATES, "2025-06-01")).toEqual({ kind: "none" });
    expect(documentVat(null, RATES, "2025-06-01")).toEqual({ kind: "unknown", missing: "status" });
    expect(documentVat(true, RATES, "2010-01-01")).toEqual({ kind: "unknown", missing: "rate" });
    expect(documentVat(true, RATES, "2024-12-31")).toEqual({ kind: "rate", rateBp: 1700 });
    expect(documentVat(true, RATES, "2025-01-01")).toEqual({ kind: "rate", rateBp: 1800 });
  });

  it("a date before the table is refused with its own message, in the app and from the database hint", () => {
    expect(documentVatError(documentVat(true, RATES, "2015-09-30"))).toBe(VAT_BEFORE_TABLE);
    expect(documentVatError(documentVat(true, RATES, "2025-01-01"))).toBeNull();
    expect(documentVatError(documentVat(false, RATES, "2010-01-01"))).toBeNull();
    expect(dbErrorMessage({ code: "P0001", message: "no VAT rate for a document dated 2015-09-30", hint: "vat:before_table" })).toBe(VAT_BEFORE_TABLE);
    expect(migration).toContain("hint = 'vat:before_table'");
  });
});
