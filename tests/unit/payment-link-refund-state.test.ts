import { describe, expect, it } from "vitest";

import { providerRefundState } from "@/features/payment-links/refund-state";

describe("provider refund requests on the card (LNK-07 review 4)", () => {
  const now = new Date("2026-11-18T12:00:00Z");
  it("shows the waiting amount, every unclear request and failures of the last week", () => {
    const state = providerRefundState(
      [
        { id: "a", amount_agorot: 100, status: "pending", created_at: "2026-11-18T10:00:00Z" },
        { id: "b", amount_agorot: 200, status: "unrecorded", created_at: "2026-10-01T10:00:00Z" },
        { id: "c", amount_agorot: 300, status: "failed", created_at: "2026-11-17T10:00:00Z" },
        { id: "d", amount_agorot: 400, status: "failed", created_at: "2026-11-01T10:00:00Z" },
        { id: "e", amount_agorot: 500, status: "refunded", created_at: "2026-11-17T10:00:00Z" },
        { id: "f", amount_agorot: "x", status: "pending" },
      ],
      now,
    );
    expect(state.pending).toBe(100);
    expect(state.unclear.map((r) => r.id)).toEqual(["b"]);
    expect(state.failed.map((r) => r.id)).toEqual(["c"]);
    expect(providerRefundState(null, now)).toEqual({ pending: null, unclear: [], failed: [] });
  });
});
