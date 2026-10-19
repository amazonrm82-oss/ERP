import { describe, expect, it } from "vitest";

import { wonOrderText } from "@/features/orders/won";

// DEAL-04 wave 2: what the close window says about the order it made (or could not make)
describe("close window order (DEAL-04)", () => {
  it("names the new order's number", () => {
    expect(wonOrderText({ ok: true, orderId: "o", numberDisplay: "ORD-1001" })).toBe("נוצרה הזמנה ORD-1001.");
    expect(wonOrderText({ ok: true, orderId: "o", numberDisplay: null })).toBe("נוצרה הזמנה.");
  });

  it("says the deal was won even when the order was refused, with the reason", () => {
    expect(wonOrderText({ ok: false, message: "כבר נוצרה הזמנה מזה." })).toBe("העסקה נסגרה, אבל ההזמנה לא נוצרה: כבר נוצרה הזמנה מזה.");
  });
});
