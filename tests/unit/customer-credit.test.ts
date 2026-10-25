import { describe, expect, it } from "vitest";

import { applyCreditLabel, creditLine, NO_CREDIT, parseAppliedCredit, parseCustomerCredit, recordedMessage } from "@/features/allocations/credit";

describe("customer credit (PAY-03)", () => {
  it("reads the database's answers and refuses a shape it does not know", () => {
    const credit = parseCustomerCredit({ total: 60000, count: 2, payments: [{ id: "p", paid_on: "2026-01-05", method: "transfer", amount: 50000, credit: 30000 }] });
    expect(credit.total).toBe(60000);
    expect(() => parseCustomerCredit({ total: -1, count: 0, payments: [] })).toThrow();
    expect(parseAppliedCredit({ allocated: 0, payments: [] })).toEqual({ allocated: 0, payments: [] });
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
});
