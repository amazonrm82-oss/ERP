import { describe, expect, it } from "vitest";

import type { ClaimedJob } from "@/features/jobs/registry";
import { createPaymentLinkPageHandler } from "@/features/payment-links/page-handler";
import { PaymentProviderRefusal } from "@/features/payment-links/providers/errors";
import { createFakePaymentProvider } from "@/features/payment-links/providers/fake";
import type { PaymentProvider } from "@/features/payment-links/providers/types";

const job: ClaimedJob = { id: "j1", lease: "l1", kind: "payment_link.create", organization_id: "o1", payload: { link_id: "k1" }, attempt: 1 };
const claimed = {
  link_id: "k1",
  provider: "fake",
  provider_link_id: "fake_k1",
  request: { organization_id: "o1", amount_agorot: 5000, currency: "ILS", max_installments: 3, expires_at: "2026-12-01T22:00:00Z", title: "תשלום" },
};

function run(claim: unknown, provider: PaymentProvider = createFakePaymentProvider(), recordAnswer: unknown = { status: "created" }) {
  const recorded: Record<string, unknown>[] = [];
  const handler = createPaymentLinkPageHandler({
    provider,
    timeoutMs: 50,
    calls: {
      claim: async () => claim,
      record: async (_job, result) => {
        recorded.push(result);
        return recordAnswer;
      },
    },
  });
  return handler(job).then((outcome) => ({ outcome, recorded }));
}

describe("payment_link.create handler (LNK-02)", () => {
  it("asks the provider with the link's id and records its id and page", async () => {
    const { outcome, recorded } = await run(claimed);
    expect(outcome).toEqual({ status: "done" });
    expect(recorded).toEqual([{ ok: true, provider_link_id: "fake_k1", hosted_url: null }]);
  });

  it("a refused claim asks nothing; finished is done, stale goes back to the queue", async () => {
    expect((await run({ refused: "finished" })).outcome).toEqual({ status: "done" });
    expect((await run({ refused: "stale" })).outcome).toMatchObject({ status: "failed" });
    const closed = await run({ refused: "source_closed" });
    expect(closed.outcome).toMatchObject({ status: "failed", final: true });
    expect(closed.recorded).toEqual([]);
  });

  it("another provider than the link's closes it; a refusal is final; a throw or timeout is tried again", async () => {
    const other = await run({ ...claimed, provider: "cardcom" });
    expect(other.recorded).toEqual([{ ok: false, code: "provider_changed", final: true }]);
    const refusing = { ...createFakePaymentProvider(), createPaymentPage: async () => { throw new PaymentProviderRefusal("amount"); } };
    expect((await run(claimed, refusing, { status: "cancelled" })).recorded).toEqual([{ ok: false, code: "amount", final: true }]);
    const broken = { ...createFakePaymentProvider(), createPaymentPage: async () => { throw new Error("socket"); } };
    const retry = await run(claimed, broken, { status: "pending" });
    expect(retry.recorded).toEqual([{ ok: false, code: "unreachable", final: false }]);
    expect(retry.outcome).toMatchObject({ status: "failed" });
    const slow = { ...createFakePaymentProvider(), createPaymentPage: () => new Promise<never>(() => {}) };
    expect((await run(claimed, slow, { status: "pending" })).recorded).toEqual([{ ok: false, code: "timeout", final: false }]);
  });

  it("a malformed claim is a failed try", async () => {
    expect((await run({ link_id: "k1" })).outcome).toMatchObject({ status: "failed", error: "claim answered an unexpected shape" });
  });
});
