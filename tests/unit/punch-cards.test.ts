import { describe, expect, it } from "vitest";

import { moneyInput, PUNCH_LOW_ENTRIES, punchBalance, punchSettingsText, refundSuggestion, remainingText } from "@/features/punch-cards/balance";
import { punchSaleQuantityProblem, punchSaleText } from "@/features/punch-cards/sale-server";

// PKG-01, PKG-02: the balance shown on the contact card (the database decides which card a meeting uses)
describe("punch card balance", () => {
  const card = (status: string, total = 10, expiresOn: string | null = "2026-12-31") => ({ status, entriesTotal: total, expiresOn });

  it("counts entries not given back, and is usable while active, in date and not used up", () => {
    expect(punchBalance(card("active"), 4, "2026-11-03")).toEqual({ total: 10, used: 4, remaining: 6, state: "active", usable: true, low: false });
    // the last day is still usable; the next day is expired and keeps its balance
    expect(punchBalance(card("active"), 4, "2026-12-31").usable).toBe(true);
    expect(punchBalance(card("active"), 4, "2027-01-01")).toMatchObject({ remaining: 6, state: "expired", usable: false, low: false });
    expect(punchBalance(card("active", 10, null), 10, "2030-01-01")).toMatchObject({ remaining: 0, state: "used_up", usable: false });
    expect(punchBalance(card("pending"), 0, "2026-11-03")).toMatchObject({ state: "pending", usable: false });
    expect(punchBalance(card("cancelled"), 2, "2026-11-03")).toMatchObject({ state: "cancelled", remaining: 8, usable: false });
  });

  it("is 'נשארו מעט' at two entries or fewer (spec 22.9)", () => {
    expect(PUNCH_LOW_ENTRIES).toBe(2);
    expect(punchBalance(card("active"), 8, "2026-11-03").low).toBe(true);
    expect(punchBalance(card("active"), 7, "2026-11-03").low).toBe(false);
  });

  it("says it in Hebrew", () => {
    expect(remainingText({ remaining: 1, total: 5 })).toBe("נשארה כניסה אחת מתוך 5");
    expect(remainingText({ remaining: 3, total: 10 })).toBe("נשארו 3 מתוך 10");
    expect(punchSettingsText(10, 3, "months")).toBe("10 כניסות, בתוקף 3 חודשים מההפעלה");
    expect(punchSettingsText(1, null, null)).toBe("כניסה אחת, בלי תוקף");
    expect(punchSettingsText(null, null, null)).toBe("עוד לא הוגדר מספר כניסות");
    expect(punchSaleText({ opened: 2, failed: 0 })).toBe("נפתחו 2 כרטיסיות ללקוח.");
    expect(punchSaleText({ opened: 0, failed: 1 })).toBe("כרטיסייה אחת לא נפתחה. אפשר לפתוח אותה מכרטיס הלקוח.");
    expect(punchSaleText({ opened: 0, failed: 0 })).toBe("");
  });

  it("suggests the unused part as the refund on cancel, half up (owner (84) ב)", () => {
    expect(refundSuggestion(3, 10, 50000)).toBe(15000);
    expect(refundSuggestion(1, 3, 10000)).toBe(3333);
    expect(refundSuggestion(2, 3, 10000)).toBe(6667);
    expect(refundSuggestion(1, 2, 1)).toBe(1);
    expect(refundSuggestion(0, 10, 50000)).toBe(0);
    expect(refundSuggestion(5, 0, 50000)).toBe(0);
    expect(moneyInput(15000)).toBe("150");
    expect(moneyInput(3333)).toBe("33.33");
  });

  it("refuses a punch card line in a fraction or over 20 units before a quick sale (review finding 3)", () => {
    const punch = new Set(["p"]);
    expect(punchSaleQuantityProblem([{ productId: "p", quantity: 2 }, { productId: "x", quantity: 1.5 }], punch)).toBeNull();
    expect(punchSaleQuantityProblem([{ productId: "p", quantity: 1.5 }], punch)).toBe("כרטיסייה נמכרת ביחידות שלמות.");
    expect(punchSaleQuantityProblem([{ productId: "p", quantity: 21 }], punch)).toBe("אפשר למכור עד 20 כרטיסיות בשורה אחת.");
    expect(punchSaleQuantityProblem([{ productId: "p", quantity: 20 }], punch)).toBeNull();
  });
});
