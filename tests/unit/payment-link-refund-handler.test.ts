import { describe, expect, it } from "vitest";

import type { ClaimedJob } from "@/features/jobs/registry";
import { createFakePaymentProvider } from "@/features/payment-links/providers/fake";
import type { PaymentProvider } from "@/features/payment-links/providers/types";
import { createPaymentLinkRefundHandler } from "@/features/payment-links/refund-handler";

const job: ClaimedJob = { id: "j1", lease: "l1", kind: "payment_link.refund", organization_id: "o1", payload: { request_id: "r1" }, attempt: 1 };
const claimed = { request_id: "r1", provider: "fake", provider_payment_id: "fake_payment_9", amount_agorot: 1000 };

async function run(claim: unknown, provider: PaymentProvider = createFakePaymentProvider(), recordAnswer: unknown = { status: "refunded" }) {
  const recorded: Record<string, unknown>[] = [];
  const handler = createPaymentLinkRefundHandler({
    provider,
    timeoutMs: 50,
    calls: { claim: async () => claim, record: async (_j, r) => (recorded.push(r), recordAnswer) },
  });
  return { outcome: await handler(job), recorded };
}

describe("payment_link.refund handler (LNK-07)", () => {
  it("asks the provider with the request's id and records its refund id", async () => {
    const seen: unknown[] = [];
    const fake = createFakePaymentProvider();
    const spy: PaymentProvider = { ...fake, refund: async (r) => (seen.push(r), fake.refund(r)) };
    const { outcome, recorded } = await run(claimed, spy);
    expect(seen).toEqual([{ idempotencyKey: "r1", providerPaymentId: "fake_payment_9", amountAgorot: 1000 }]);
    expect(recorded[0]).toMatchObject({ ok: true });
    expect(outcome).toEqual({ status: "done" });
  });

  it("a provider refusal is final; a timeout or throw is tried again; a refused claim asks nothing", async () => {
    const refusing = { ...createFakePaymentProvider(), refund: async () => ({ ok: false as const, code: "not_refundable" }) };
    expect((await run(claimed, refusing, { status: "failed" })).recorded).toEqual([{ ok: false, code: "not_refundable", final: true }]);
    const broken = { ...createFakePaymentProvider(), refund: async () => { throw new Error("socket"); } };
    const retry = await run(claimed, broken, { status: "pending" });
    expect(retry.recorded).toEqual([{ ok: false, code: "unreachable", final: false }]);
    expect(retry.outcome).toMatchObject({ status: "failed" });
    const slow = { ...createFakePaymentProvider(), refund: () => new Promise<never>(() => {}) };
    expect((await run(claimed, slow, { status: "pending" })).recorded).toEqual([{ ok: false, code: "timeout", final: false }]);
    const refused = await run({ refused: "requester_gone" });
    expect(refused.recorded).toEqual([]);
    expect(refused.outcome).toMatchObject({ status: "failed", final: true });
    expect((await run({ refused: "finished" })).outcome).toEqual({ status: "done" });
  });
});
