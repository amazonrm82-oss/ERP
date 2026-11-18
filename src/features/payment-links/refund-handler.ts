// LNK-07 (owner (394) א): the OPS-04 handler of payment_link.refund. Pure of the database: it gets the two worker calls
// (public.payment_link_refund_claim and public.payment_link_refund_record, service_role, on the job's live lease) and the
// payment provider, and asks for the refund with the REQUEST'S ID as the idempotency key, so a retry never refunds twice.
// The refund is recorded by the database only after the provider answered ok.

import { z } from "zod";

import type { ClaimedJob, JobHandler } from "@/features/jobs/registry";

import { finishFrom, PAYMENT_PROVIDER_TIMEOUT_MS, providerFailure, withTimeout } from "./page-handler";
import type { PaymentProvider } from "./providers/types";

const claimSchema = z.union([
  z.object({ refused: z.string().regex(/^[a-z_:]{1,40}$/) }).passthrough(),
  z.object({ request_id: z.string(), provider: z.string(), provider_payment_id: z.string(), amount_agorot: z.number().int().positive() }),
]);

export type PaymentLinkRefundCalls = {
  claim: (job: ClaimedJob) => Promise<unknown>;
  record: (job: ClaimedJob, result: Record<string, unknown>) => Promise<unknown>;
};

export function createPaymentLinkRefundHandler(deps: { calls: PaymentLinkRefundCalls; provider: PaymentProvider; timeoutMs?: number }): JobHandler {
  return async (job) => {
    const claimed = claimSchema.safeParse(await deps.calls.claim(job));
    if (!claimed.success) return { status: "failed", error: "claim answered an unexpected shape" };
    const answer = claimed.data;
    if ("refused" in answer) {
      if (answer.refused === "stale") return { status: "failed", error: "stale lease" };
      if (answer.refused === "finished") return { status: "done" };
      return { status: "failed", error: `refused ${answer.refused}`, final: true, receipt: { provider: null, errorCode: answer.refused } };
    }
    if (answer.provider !== deps.provider.code) {
      await deps.calls.record(job, { ok: false, code: "provider_changed", final: true });
      return { status: "failed", error: "provider changed", final: true, receipt: { provider: null, errorCode: "provider_changed" } };
    }
    let result: Record<string, unknown>;
    try {
      const refund = await withTimeout(
        deps.provider.refund({ idempotencyKey: answer.request_id, providerPaymentId: answer.provider_payment_id, amountAgorot: answer.amount_agorot }),
        deps.timeoutMs ?? PAYMENT_PROVIDER_TIMEOUT_MS,
      );
      result =
        refund === "timeout"
          ? { ok: false, code: "timeout", final: false }
          : refund.ok
            ? { ok: true, provider_refund_id: refund.providerRefundId }
            : { ok: false, code: refund.code, final: true };
    } catch (error) {
      result = providerFailure(error);
    }
    return finishFrom(await deps.calls.record(job, result));
  };
}
