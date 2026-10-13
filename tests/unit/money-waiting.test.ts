import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { dealGroup, MONEY_GROUPS, moneySummary } from "@/features/money-waiting/groups";
import { parseReportData } from "@/features/reports/schemas";

const sample = () =>
  parseReportData("report_money_waiting", JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/reports/report_money_waiting.json"), "utf8")));

// MNY-01: the groups of "כסף שמחכה" and how they add up
describe("money waiting (MNY-01)", () => {
  it("the main number is the money to close; the estimate is never added to it", () => {
    const data = sample();
    const withEstimate = { ...data, estimate: { ...data.estimate, leads: 3, won_deals: 6, average: 1000, amount: 3000 } };
    const summary = moneySummary(withEstimate);
    expect(summary.total).toBe(data.to_close.amount);
    expect(summary.parts).toEqual([{ part: "to_close", amount: data.to_close.amount }]);
    expect(summary.estimate).toMatchObject({ leads: 3, average: 1000, amount: 3000 });
    expect(summary.groups.unhandled_leads).toEqual({ count: 3, amount: 3000 });
  });

  it("without enough won deals the estimate has no amount", () => {
    const data = sample();
    const summary = moneySummary({ ...data, estimate: { ...data.estimate, leads: 4, won_deals: 2, average: null, amount: null } });
    expect(summary.estimate.amount).toBeNull();
    expect(summary.total).toBe(data.to_close.amount);
  });

  it("a deal is listed once: stuck wins over overdue", () => {
    expect(dealGroup({ stuck: true, overdue: true })).toBe("stuck");
    expect(dealGroup({ stuck: false, overdue: true })).toBe("overdue");
    expect(dealGroup({ stuck: false, overdue: false })).toBeNull();
  });

  it("only the groups whose module exists, money to close before the estimate", () => {
    expect(MONEY_GROUPS.map((g) => g.key)).toEqual(["stuck", "overdue", "unhandled_leads"]);
    expect(MONEY_GROUPS.map((g) => g.part)).toEqual(["to_close", "to_close", "estimate"]);
  });
});
