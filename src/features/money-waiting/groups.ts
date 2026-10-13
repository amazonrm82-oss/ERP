// MNY-01, "כסף שמחכה": the groups of the screen and how they add up. Pure, so unit tests and
// client code can use it.
//
// Additions spec 18.6 names six groups; a group appears when its module is built. Today: stuck
// deals and overdue deals (money to close) and unhandled leads (an estimate). The extension point
// for the rest is this list plus a key of public.report_money_waiting:
//   * quotes sent and not answered (QUO) -> part "to_close", listed before the deals; a deal with an
//     open quote is counted in quotes only (the SQL leaves it out of stuck and overdue);
//   * overdue debts (COL / PAY)           -> part "owed" (the first part of the main number);
//   * renewals in the coming month       -> part "to_close";
//   * dormant customers (RET-01)          -> part "estimate", by the same average deal value.
// No placeholder is shown for a group whose module does not exist.

import type { ReportData } from "@/features/reports/schemas";

/** The main number has two parts (money owed, money to close); the estimate is shown apart and never added. */
export type MoneyPart = "owed" | "to_close" | "estimate";

export type MoneyGroupKey = "stuck" | "overdue" | "unhandled_leads";

export type MoneyGroup = {
  key: MoneyGroupKey;
  part: MoneyPart;
  title: string;
  // one line under the title: what puts a record in the group
  description: string;
};

export const MONEY_GROUPS: readonly MoneyGroup[] = [
  {
    key: "stuck",
    part: "to_close",
    title: "עסקאות תקועות",
    description: "עסקאות שנמצאות בשלב יותר מהזמן שנקבע לו.",
  },
  {
    key: "overdue",
    part: "to_close",
    title: "עסקאות שתאריך הסגירה שלהן עבר",
    description: "עסקאות פתוחות שתאריך הסגירה הצפוי שלהן כבר עבר.",
  },
  {
    key: "unhandled_leads",
    part: "estimate",
    title: "לידים שלא טופלו",
    description: "לידים פתוחים שעוד לא קיבלו מענה, לפי ערך ממוצע של העסקאות שזכיתם בהן ב-90 הימים האחרונים ואתם רואים.",
  },
];

export const MONEY_PART_LABELS: Record<MoneyPart, string> = {
  owed: "כסף שכבר חייבים לעסק",
  to_close: "כסף שעוד צריך לסגור",
  estimate: "הערכה",
};

type Money = ReportData<"report_money_waiting">;

export type MoneySummary = {
  // the main number: the parts that exist today ("owed" joins with debts)
  total: number;
  parts: Array<{ part: Exclude<MoneyPart, "estimate">; amount: number }>;
  groups: Record<MoneyGroupKey, { count: number; amount: number | null }>;
  // the estimate, never inside total; null amount: not enough won deals for an average
  estimate: { leads: number; average: number | null; amount: number | null; wonDeals: number; days: number; minDeals: number };
};

/** The report's totals as the screen shows them. Each deal is counted once (the SQL splits stuck and overdue). */
export function moneySummary(data: Money): MoneySummary {
  return {
    total: data.to_close.amount,
    parts: [{ part: "to_close", amount: data.to_close.amount }],
    groups: {
      stuck: { count: data.stuck.deals, amount: data.stuck.amount },
      overdue: { count: data.overdue.deals, amount: data.overdue.amount },
      unhandled_leads: { count: data.estimate.leads, amount: data.estimate.amount },
    },
    estimate: {
      leads: data.estimate.leads,
      average: data.estimate.average,
      amount: data.estimate.amount,
      wonDeals: data.estimate.won_deals,
      days: data.estimate.days,
      minDeals: data.estimate.min_deals,
    },
  };
}

/** The group a deal row of the report belongs to: stuck wins, so a deal is listed once. */
export function dealGroup(row: { stuck: boolean; overdue: boolean }): "stuck" | "overdue" | null {
  if (row.stuck) return "stuck";
  if (row.overdue) return "overdue";
  return null;
}
