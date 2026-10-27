import { describe, expect, it } from "vitest";

import { appliedCreditMessage, applyCreditLabel, creditLine, NO_CREDIT, parseAppliedCredit, parseCustomerCredit, recordedMessage } from "@/features/allocations/credit";

describe("customer credit (PAY-03)", () => {
  it("reads the database's answers and refuses a shape it does not know", () => {
    const credit = parseCustomerCredit({ total: 60000, count: 2, payments: [{ id: "p", paid_on: "2026-01-05", method: "transfer", amount: 50000, credit: 30000 }] });
    expect(credit.total).toBe(60000);
    expect(() => parseCustomerCredit({ total: -1, count: 0, payments: [] })).toThrow();
    // GAP-12: an answer without opening credits reads as none
    expect(parseAppliedCredit({ allocated: 0, payments: [] })).toEqual({ allocated: 0, payments: [], documents: [] });
    expect(() => parseAppliedCredit({ allocated: "x" })).toThrow();
  });

  it("words the card line, the checkbox and the message after saving", () => {
    expect(creditLine(NO_CREDIT)).toBeNull();
    expect(creditLine({ total: 30000, count: 1, payments: [] })).toContain("מתשלום אחד");
    expect(creditLine({ total: 60000, count: 2, payments: [] })).toContain("מ-2 תשלומים");
    expect(applyCreditLabel(60000)).toContain("לקזז מיתרת הזכות");
    expect(recordedMessage(null, false)).toBe("המסמך נרשם.");
    expect(recordedMessage({ allocated: 0, payments: [] }, false)).toBe("המסמך נרשם.");
    expect(recordedMessage({ allocated: 60000, payments: [] }, false)).toContain("וקוזזו");
    expect(recordedMessage(null, true)).toContain("לא הצליח");
  });

  it("GAP-12: an opening credit is part of the customer's credit and of the card line", () => {
    const opening = parseCustomerCredit({ total: 500, count: 0, payments: [], documents: [{ id: "d1", doc_date: "2026-01-01", credit: 500 }] });
    expect(opening.documents).toHaveLength(1);
    expect(creditLine(opening)).toContain("מיתרת הפתיחה");
    expect(creditLine({ total: 900, count: 1, payments: [], documents: [{ id: "d1", doc_date: "2026-01-01", credit: 400 }] })).toContain("מתשלום אחד ומיתרת הפתיחה");
    // an older answer without documents still reads
    expect(parseCustomerCredit({ total: 0, count: 0, payments: [] }).documents).toEqual([]);
    expect(appliedCreditMessage(12000)).toContain("קוזזו");
  });
});
