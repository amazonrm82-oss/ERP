import { describe, expect, it } from "vitest";

import { moneyRemainders, moneyStateTone, parseOrderMoney, stepState, BILLING_STATE_LABELS, PAYMENT_STATE_LABELS } from "@/features/orders/money";

const ID = "11111111-1111-4111-8111-111111111111";

// ORD-02 / ORD-04: the app only parses and words what public.order_money_state works out
describe("order billing and payment (ORD-02, ORD-04)", () => {
  it("parses the database's answer by order id; amounts may arrive as text", () => {
    const map = parseOrderMoney({
      orders: [
        {
          id: ID,
          status: "new",
          total: "11800",
          partial: false,
          billed: 5000,
          paid: "0",
          requested: 0,
          billing_state: "partly_billed",
          payment_state: "unpaid",
          steps: [{ id: "s1", amount: 5900, billed: 5000, paid: 0 }],
        },
      ],
    });
    expect(map.get(ID)).toEqual({
      id: ID,
      totalAgorot: 11800,
      partial: false,
      billedAgorot: 5000,
      paidAgorot: 0,
      requestedAgorot: 0,
      billingState: "partly_billed",
      paymentState: "unpaid",
      steps: [{ id: "s1", amountAgorot: 5900, billedAgorot: 5000, paidAgorot: 0 }],
    });
  });

  it("a partial view and a draft parse with nulls; an unknown state is refused", () => {
    const map = parseOrderMoney({
      orders: [
        { id: "a", total: 100, partial: true, billed: null, paid: null, requested: null, billing_state: "unknown", payment_state: "unknown", steps: [] },
        { id: "b", total: 0, partial: false, billed: 0, paid: 0, requested: 0, billing_state: null, payment_state: null, steps: [] },
      ],
    });
    expect(map.get("a")?.billingState).toBe("unknown");
    expect(map.get("b")?.paymentState).toBeNull();
    expect(() => parseOrderMoney({ orders: [{ id: "c", total: 1, partial: false, billed: 0, paid: 0, requested: 0, billing_state: "whatever", payment_state: null, steps: [] }] })).toThrow();
  });

  it("works out what is left and what was beyond the total", () => {
    expect(moneyRemainders({ totalAgorot: 1000, billedAgorot: 400, paidAgorot: 1200 })).toEqual({ toBill: 600, toPay: 0, overBilled: 0, overPaid: 200 });
    expect(moneyRemainders({ totalAgorot: 1000, billedAgorot: null, paidAgorot: null })).toEqual({ toBill: null, toPay: null, overBilled: 0, overPaid: 0 });
  });

  it("words each schedule step: paid wins over billed", () => {
    const step = (billed: number | null, paid: number | null, amount = 100) => stepState({ id: "s", amountAgorot: amount, billedAgorot: billed, paidAgorot: paid });
    expect(step(0, 0)).toBe("open");
    expect(step(50, 0)).toBe("partly_billed");
    expect(step(100, 0)).toBe("billed");
    expect(step(100, 30)).toBe("partly_paid");
    expect(step(0, 100)).toBe("paid");
    expect(step(null, null)).toBe("unknown");
    expect(step(0, 0, 0)).toBe("open");
  });

  it("has a label and a tone for every state", () => {
    for (const state of ["not_billed", "partly_billed", "billed", "unknown"] as const) expect(BILLING_STATE_LABELS[state]).toBeTruthy();
    for (const state of ["unpaid", "partly_paid", "paid", "unknown"] as const) expect(PAYMENT_STATE_LABELS[state]).toBeTruthy();
    expect(moneyStateTone("paid")).toBe("success");
    expect(moneyStateTone("partly_billed")).toBe("warning");
    expect(moneyStateTone("unpaid")).toBe("neutral");
  });
});
