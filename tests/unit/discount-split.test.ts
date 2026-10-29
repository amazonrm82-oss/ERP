import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { discountSplit } from "@/features/tax/discount-split";

type Case = { name: string; totals: number[]; discount: number; shares: number[] | null };
const fixture = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/discount-split.json"), "utf8")) as { cases: Case[] };

// DSC-01: a document discount split between its lines for reports; tests/db/273 runs the same cases on app.discount_split
describe("discountSplit (DSC-01)", () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      expect(discountSplit(c.totals, c.discount)).toEqual(c.shares);
    });
  }

  it("adds up to the discount and never gives a line more than its total", () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let run = 0; run < 500; run++) {
      const totals = Array.from({ length: 1 + rand(8) }, () => rand(5) === 0 ? 0 : rand(100000));
      const sum = totals.reduce((a, b) => a + b, 0);
      const discount = rand(sum + 1);
      const shares = discountSplit(totals, discount);
      expect(shares).not.toBeNull();
      expect(shares!.reduce((a, b) => a + b, 0)).toBe(discount);
      shares!.forEach((s, i) => {
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(totals[i]);
      });
    }
  });

  it("refuses non-integers", () => {
    expect(discountSplit([1.5], 1)).toBeNull();
    expect(discountSplit([10], 0.5)).toBeNull();
  });
});
