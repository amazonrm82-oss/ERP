import { describe, expect, it } from "vitest";

import { priceHistory } from "@/features/products/price-history";

const entry = (id: number, changes: Record<string, { old: unknown; new: unknown }> | { erased: true }) => ({
  id,
  createdAt: `2026-10-${String(id).padStart(2, "0")}T09:00:00Z`,
  actorName: "דנה",
  changes: changes as never,
});

describe("price history (PRD-07)", () => {
  it("rebuilds the whole price before and after, newest first", () => {
    const now = { priceAgorot: 15000, priceIncludesVat: true, vatKind: "taxable" as const };
    const changes = priceHistory(now, [
      entry(3, { price_includes_vat: { old: false, new: true } }),
      entry(2, { price_agorot: { old: 10000, new: 15000 }, name: { old: "א", new: "ב" } }),
      entry(1, { price_agorot: { old: 9000, new: 10000 }, vat_kind: { old: "exempt", new: "taxable" } }),
    ]);
    expect(changes.map((c) => c.id)).toEqual([3, 2, 1]);
    expect(changes[0].before).toContain("לפני מע\"מ");
    expect(changes[0].after).toContain("כולל מע\"מ");
    expect(changes[0].before).toContain("150");
    expect(changes[1].before).toContain("100");
    expect(changes[1].after).toContain("150");
    expect(changes[1].before).toContain("לפני מע\"מ");
    // before the third-oldest change the product was exempt: a bare price
    expect(changes[2].before).not.toContain("מע\"מ");
    expect(changes[2].before).toContain("90");
  });

  it("leaves out entries that change nothing visible and erased entries", () => {
    const now = { priceAgorot: 500, priceIncludesVat: false, vatKind: "exempt" as const };
    const changes = priceHistory(now, [
      entry(2, { erased: true }),
      // exempt to zero rate: the bare price reads the same
      entry(1, { vat_kind: { old: "zero_rate", new: "exempt" } }),
    ]);
    expect(changes).toEqual([]);
  });

  it("ignores values that are not what the column holds", () => {
    const now = { priceAgorot: 500, priceIncludesVat: false, vatKind: "taxable" as const };
    const changes = priceHistory(now, [entry(1, { price_agorot: { old: "abc", new: 500 }, vat_kind: { old: "half", new: "taxable" } })]);
    expect(changes).toEqual([]);
  });
});
