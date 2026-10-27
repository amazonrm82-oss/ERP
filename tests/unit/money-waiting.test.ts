import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { dealGroup, MONEY_GROUPS, moneySummary, shownGroups } from "@/features/money-waiting/groups";
import { rowActions } from "@/features/money-waiting/row-actions";
import { parseReportData } from "@/features/reports/schemas";

const sample = () =>
  parseReportData("report_money_waiting", JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/reports/report_money_waiting.json"), "utf8")));

// MNY-01: the groups of "כסף שמחכה" and how they add up
describe("money waiting (MNY-01)", () => {
  it("the main number is owed + to close (deals, quotes, renewals); the estimate is never added to it", () => {
    const data = sample();
    const withEstimate = {
      ...data,
      estimate: {
        ...data.estimate,
        leads: 3,
        won_deals: 6,
        average: 1000,
        amount: 3000,
      },
    };
    const summary = moneySummary(withEstimate);
    const toClose = data.to_close.amount + data.quotes!.amount + data.renewals.amount;
    expect(summary.parts).toEqual([
      { part: "owed", amount: data.debts!.amount },
      { part: "to_close", amount: toClose },
    ]);
    expect(summary.total).toBe(data.debts!.amount + toClose);
    expect(summary.estimate).toMatchObject({
      leads: 3,
      average: 1000,
      amount: 3000,
    });
    expect(summary.groups.unhandled_leads).toEqual({ count: 3, amount: 3000 });
    expect(summary.groups.quotes).toEqual({
      count: data.quotes!.count,
      amount: data.quotes!.amount,
    });
    expect(summary.groups.renewals).toEqual({
      count: data.renewals.count,
      amount: data.renewals.amount,
    });
  });

  it("without enough won deals the estimate has no amount", () => {
    const data = sample();
    const summary = moneySummary({
      ...data,
      estimate: {
        ...data.estimate,
        leads: 4,
        won_deals: 2,
        average: null,
        amount: null,
      },
    });
    expect(summary.estimate.amount).toBeNull();
    expect(summary.total).toBe(data.debts!.amount + data.to_close.amount + data.quotes!.amount + data.renewals.amount);
  });

  it("a group whose plan flag is off is not shown and adds nothing; without debts there is no owed part", () => {
    const data = sample();
    const summary = moneySummary({ ...data, quotes: null, debts: null });
    expect(summary.groups.quotes).toBeNull();
    expect(summary.groups.debts).toBeNull();
    expect(summary.parts).toEqual([{ part: "to_close", amount: data.to_close.amount + data.renewals.amount }]);
    expect(summary.total).toBe(data.to_close.amount + data.renewals.amount);
    expect(shownGroups(summary).map((g) => g.key)).toEqual(["stuck", "overdue", "renewals", "unhandled_leads"]);
  });

  it("a deal is listed once: stuck wins over overdue", () => {
    expect(dealGroup({ stuck: true, overdue: true })).toBe("stuck");
    expect(dealGroup({ stuck: false, overdue: true })).toBe("overdue");
    expect(dealGroup({ stuck: false, overdue: false })).toBeNull();
  });

  it("only the groups whose module exists: owed first, money to close, then the estimate", () => {
    expect(MONEY_GROUPS.map((g) => g.key)).toEqual(["debts", "quotes", "stuck", "overdue", "renewals", "unhandled_leads"]);
    expect(MONEY_GROUPS.map((g) => g.part)).toEqual(["owed", "to_close", "to_close", "to_close", "to_close", "estimate"]);
  });

  it("an overdue debt's customer with a number gets a WhatsApp reminder first", () => {
    const base = {
      ownerId: "u",
      phoneE164: "+972501234567",
      canWrite: true,
      canReassign: true,
    };
    expect(rowActions({ ...base, kind: "contact", reminder: true })[0]).toBe("whatsapp");
    expect(rowActions({ ...base, kind: "contact" })[0]).toBe("task");
    expect(
      rowActions({
        ...base,
        kind: "contact",
        reminder: true,
        phoneE164: null,
      })[0],
    ).toBe("task");
  });
});
