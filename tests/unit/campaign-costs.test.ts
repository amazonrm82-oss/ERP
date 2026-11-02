import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { amountBeforeVat, campaignCostSchema, monthStart } from "@/features/campaign-costs/schema";

const cases = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/amount-before-vat.json"), "utf8")) as Array<{
  amount: number;
  rate_bp: number;
  expected: number | null;
}>;

// SEG-03, owner (63) ב: a cost typed with VAT is counted before VAT, half up (= app.amount_before_vat, test 285 runs the
// same fixture in SQL)
describe("campaign costs (SEG-03)", () => {
  it.each(cases.map((c) => [c.amount, c.rate_bp, c.expected]))("%i with VAT at %i bp is %s before VAT", (amount, rate, expected) => {
    expect(amountBeforeVat(amount as number, rate as number)).toBe(expected);
  });

  it("reads the form: a month, an amount in shekels, a source or a campaign, VAT unchecked by default", () => {
    expect(monthStart("2026-11")).toBe("2026-11-01");
    expect(monthStart("2026-13")).toBeNull();
    const parsed = campaignCostSchema.parse({ source_id: "", campaign: "חורף", month: "2026-11", amount: "2,500", note: "" });
    expect(parsed).toMatchObject({ source_id: null, campaign: "חורף", month: "2026-11-01", amount: 250000, note: null, amount_includes_vat: false });
    expect(campaignCostSchema.parse({ campaign: "x", month: "2026-11", amount: "1", amount_includes_vat: "on" }).amount_includes_vat).toBe(true);
    expect(campaignCostSchema.safeParse({ source_id: "", campaign: "", month: "2026-11", amount: "10" }).success).toBe(false);
    expect(campaignCostSchema.safeParse({ campaign: "x", month: "", amount: "10" }).success).toBe(false);
    expect(campaignCostSchema.safeParse({ campaign: "x", month: "2026-11", amount: "0" }).success).toBe(false);
  });
});
