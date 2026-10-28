import { describe, expect, it } from "vitest";

import { AGING_BUCKETS, agingRows, daysBetween, documentsText, overdueDetail, parseDebtSummary, type FullDebtSummary } from "@/features/balances/debt";
import { catalogFor, DEBT_COLUMNS, offeredSortKeys } from "@/features/list-columns/columns";
import { CONTACT_SORT_COLUMNS } from "@/features/contacts/queries";
import { COMPANY_SORT_COLUMNS } from "@/features/companies/queries";

// BAL-02: the card's answer, its words, and the list columns offered only to people who see balances.
describe("customer debt (BAL-02)", () => {
  const full: FullDebtSummary = {
    allowed: true,
    partial: false,
    today: "2026-10-28",
    open_debt: 14700,
    open_documents: 4,
    overdue_debt: 9000,
    overdue_documents: 2,
    oldest_due_date: "2026-09-18",
    aging: { current: 5700, d1_30: 3000, d31_60: 6000, d61_90: 0, d91_plus: 0 },
  };

  it("parses the three answers and refuses an unknown shape", () => {
    expect(parseDebtSummary({ allowed: false })).toEqual({ allowed: false });
    expect(parseDebtSummary({ allowed: true, partial: true })).toEqual({ allowed: true, partial: true });
    expect(parseDebtSummary({ ...full, open_debt: "14700" })).toEqual(full);
    expect(() => parseDebtSummary({ allowed: true, partial: false, open_debt: 1 })).toThrow();
    expect(() => parseDebtSummary({ ...full, overdue_debt: -1 })).toThrow();
  });

  it("words the overdue detail", () => {
    expect(daysBetween("2026-09-18", "2026-10-28")).toBe(40);
    expect(documentsText(1)).toBe("מסמך אחד");
    expect(documentsText(3)).toBe("3 מסמכים");
    expect(overdueDetail(full)).toBe("2 מסמכים, הוותיק באיחור של 40 ימים");
    expect(overdueDetail({ ...full, overdue_documents: 1, oldest_due_date: "2026-10-27" })).toBe("מסמך אחד, הוותיק באיחור של יום אחד");
    expect(overdueDetail({ ...full, overdue_debt: 0, overdue_documents: 0, oldest_due_date: null })).toBeNull();
  });

  it("offers the debt columns and their sort only with the balances keys", () => {
    for (const object of ["contact", "company"] as const) {
      const without = catalogFor(object, [], { money: true });
      const withDebt = catalogFor(object, [], { money: true, debt: true });
      expect(without.map((c) => c.key)).not.toContain("debt");
      expect(withDebt.filter((c) => DEBT_COLUMNS.includes(c.key)).map((c) => c.label)).toEqual(["יתרת חוב", "חוב באיחור"]);
      const keys = Object.keys(object === "contact" ? CONTACT_SORT_COLUMNS : COMPANY_SORT_COLUMNS);
      expect(offeredSortKeys(keys, without)).not.toContain("overdue_debt");
      expect(offeredSortKeys(keys, without)).toContain("credit");
      expect(offeredSortKeys(keys, withDebt)).toEqual(expect.arrayContaining(["debt", "overdue_debt", "credit"]));
      expect(offeredSortKeys(keys, catalogFor(object, [], {}))).not.toContain("credit");
    }
    expect(CONTACT_SORT_COLUMNS.debt).toBe("debt_balance");
    expect(COMPANY_SORT_COLUMNS.overdue_debt).toBe("overdue_debt");
  });

  // BAL-03
  it("lists the aging buckets in order with their share", () => {
    expect(AGING_BUCKETS.map((b) => b.key)).toEqual(["current", "d1_30", "d31_60", "d61_90", "d91_plus"]);
    expect(agingRows(full.aging).map((r) => [r.key, r.amount, r.percent])).toEqual([
      ["current", 5700, 39],
      ["d1_30", 3000, 20],
      ["d31_60", 6000, 41],
      ["d61_90", 0, 0],
      ["d91_plus", 0, 0],
    ]);
    expect(agingRows({ current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d91_plus: 0 }).every((r) => r.percent === null)).toBe(true);
    expect(() => parseDebtSummary({ ...full, aging: { current: 1 } })).toThrow();
  });
});
