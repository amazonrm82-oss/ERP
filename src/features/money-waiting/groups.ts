// MNY-01, "כסף שמחכה": the groups of the screen and how they add up. Pure, so unit tests and
// client code can use it.
//
// Additions spec 18.6 names six groups; a group appears when its module is built (and the business's
// plan has its key: the report answers null for a group whose flag is off, and the screen leaves it
// out). Built: overdue debts (part "owed", flags documents + payments), quotes sent and not answered
// (part "to_close", flag quotes; a deal with an open quote is counted in quotes only, the SQL leaves it
// out of stuck, overdue and renewals), stuck and overdue deals, renewals in the next 30 days (part
// "to_close"; a deal counted elsewhere is not a renewal too) and unhandled leads (an estimate). Still to
// come: dormant customers (RET-01) -> part "estimate", by the same average deal value. No placeholder is
// shown for a group whose module does not exist.

import type { ReportData } from "@/features/reports/schemas";

/** The main number has two parts (money owed, money to close); the estimate is shown apart and never added. */
export type MoneyPart = "owed" | "to_close" | "estimate";

export type MoneyGroupKey = "debts" | "quotes" | "stuck" | "overdue" | "renewals" | "unhandled_leads";

export type MoneyGroup = {
  key: MoneyGroupKey;
  part: MoneyPart;
  title: string;
  // one line under the title: what puts a record in the group
  description: string;
};

export const MONEY_GROUPS: readonly MoneyGroup[] = [
  {
    key: "debts",
    part: "owed",
    title: "חובות באיחור",
    description: 'חשבוניות, חשבונות עסקה ויתרות פתיחה שמועד התשלום שלהן עבר ועוד לא שולמו במלואן. הסכום הוא היתרה, כולל מע"מ.',
  },
  {
    key: "quotes",
    part: "to_close",
    title: "הצעות מחיר שנשלחו ולא נענו",
    description: 'הצעות שנשלחו ועוד בתוקף, בלי תשובה מהלקוח. כל הצעה פעם אחת, בגרסה האחרונה שנשלחה. הסכום לפני מע"מ.',
  },
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
    key: "renewals",
    part: "to_close",
    title: "חידושים בחודש הקרוב",
    description: "עסקאות עם הכנסה חוזרת שתאריך החידוש שלהן ב-30 הימים הקרובים. הסכום הוא תקופה אחת של הסכום החוזר.",
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
  // the main number: owed + to close (the estimate is never in it)
  total: number;
  // the parts that exist for this business ("owed" only while the debts group is shown)
  parts: Array<{ part: Exclude<MoneyPart, "estimate">; amount: number }>;
  // null: the group's module is not in the business's plan, so the screen does not show it
  groups: Record<MoneyGroupKey, { count: number; amount: number | null } | null>;
  // the estimate, never inside total; null amount: not enough won deals for an average
  estimate: { leads: number; average: number | null; amount: number | null; wonDeals: number; days: number; minDeals: number };
};

/** The report's totals as the screen shows them. Each record is counted once (the SQL splits the groups). */
export function moneySummary(data: Money): MoneySummary {
  const toClose = data.to_close.amount + (data.quotes?.amount ?? 0) + data.renewals.amount;
  const parts: MoneySummary["parts"] = [];
  if (data.debts) parts.push({ part: "owed", amount: data.debts.amount });
  parts.push({ part: "to_close", amount: toClose });
  return {
    total: parts.reduce((sum, part) => sum + part.amount, 0),
    parts,
    groups: {
      debts: data.debts ? { count: data.debts.count, amount: data.debts.amount } : null,
      quotes: data.quotes ? { count: data.quotes.count, amount: data.quotes.amount } : null,
      stuck: { count: data.stuck.deals, amount: data.stuck.amount },
      overdue: { count: data.overdue.deals, amount: data.overdue.amount },
      renewals: { count: data.renewals.count, amount: data.renewals.amount },
      unhandled_leads: {
        count: data.estimate.leads,
        amount: data.estimate.amount,
      },
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

/** The groups the screen shows for this business: those whose module is in its plan. */
export function shownGroups(summary: MoneySummary): MoneyGroup[] {
  return MONEY_GROUPS.filter((group) => summary.groups[group.key] !== null);
}

/** The group a deal row of the report belongs to: stuck wins, so a deal is listed once. */
export function dealGroup(row: { stuck: boolean; overdue: boolean }): "stuck" | "overdue" | null {
  if (row.stuck) return "stuck";
  if (row.overdue) return "overdue";
  return null;
}
