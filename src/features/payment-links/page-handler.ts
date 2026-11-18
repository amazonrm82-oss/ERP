// LNK-02 (owner (394) א): the OPS-04 handler of payment_link.create. Pure of the database: it gets the two worker calls
// (public.payment_link_page_claim and public.payment_link_page_record, service_role, on the job's live lease) and the payment
// provider, and asks the provider for the hosted page with the LINK'S ID as the idempotency key, so a retry never makes two
// pages. Every check lives in the claim; the queue holds the link's id only. Nothing here carries card details (LNK-03).

import { z } from "zod";

import type { ClaimedJob, JobHandler, JobOutcome } from "@/features/jobs/registry";

import { PaymentProviderRefusal } from "./providers/errors";
import type { PaymentProvider } from "./providers/types";

export const PAYMENT_PROVIDER_TIMEOUT_MS = 10_000;

const claimSchema = z.union([
  z.object({ refused: z.string().regex(/^[a-z_:]{1,40}$/) }).passthrough(),
  z.object({
    link_id: z.string(),
    provider: z.string(),
    provider_link_id: z.string().nullable(),
    request: z.object({
      organization_id: z.string(),
      amount_agorot: z.number().int().positive(),
      currency: z.literal("ILS"),
      max_installments: z.number().int().min(1).max(36),
      expires_at: z.string(),
      title: z.string(),
    }),
  }),
]);

const recordSchema = z.object({ status: z.string() }).passthrough();

export type PaymentLinkPageCalls = {
  claim: (job: ClaimedJob) => Promise<unknown>;
  record: (job: ClaimedJob, result: Record<string, unknown>) => Promise<unknown>;
};

export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** The answer of a provider call as the record takes it: a final refusal, or a failure to try again (timeout, throw). */
export function providerFailure(error: unknown): { ok: false; code: string; final: boolean } {
  if (error instanceof PaymentProviderRefusal) return { ok: false, code: error.code, final: error.final };
  return { ok: false, code: "unreachable", final: false };
}

export function createPaymentLinkPageHandler(deps: { calls: PaymentLinkPageCalls; provider: PaymentProvider; timeoutMs?: number }): JobHandler {
  return async (job) => {
    const claimed = claimSchema.safeParse(await deps.calls.claim(job));
    if (!claimed.success) return { status: "failed", error: "claim answered an unexpected shape" };
    const answer = claimed.data;
    if ("refused" in answer) {
      if (answer.refused === "stale") return { status: "failed", error: "stale lease" };
      // the link already has its page or no longer waits for one: nothing is asked of the provider
      if (answer.refused === "finished" || answer.refused === "expired") return { status: "done" };
      return { status: "failed", error: `refused ${answer.refused}`, final: true, receipt: { provider: null, errorCode: answer.refused } };
    }
    // the link was made for this provider; another one offered now never makes its page: the link is closed at once
    if (answer.provider !== deps.provider.code) {
      await deps.calls.record(job, { ok: false, code: "provider_changed", final: true });
      return { status: "failed", error: "provider changed", final: true, receipt: { provider: null, errorCode: "provider_changed" } };
    }
    let result: Record<string, unknown>;
    try {
      const page = await withTimeout(
        deps.provider.createPaymentPage({
          linkId: answer.link_id,
          organizationId: answer.request.organization_id,
          amountAgorot: answer.request.amount_agorot,
          currency: answer.request.currency,
          maxInstallments: answer.request.max_installments,
          expiresAt: answer.request.expires_at,
          title: answer.request.title,
        }),
        deps.timeoutMs ?? PAYMENT_PROVIDER_TIMEOUT_MS,
      );
      result = page === "timeout" ? { ok: false, code: "timeout", final: false } : { ok: true, provider_link_id: page.providerLinkId, hosted_url: page.hostedUrl };
    } catch (error) {
      result = providerFailure(error);
    }
    return finishFrom(await deps.calls.record(job, result));
  };
}

/** The job's outcome from a record's answer: stale and pending go back to the queue; anything else is done. */
export function finishFrom(answer: unknown): JobOutcome {
  const recorded = recordSchema.safeParse(answer);
  if (!recorded.success) return { status: "failed", error: "record answered an unexpected shape" };
  if (recorded.data.status === "stale") return { status: "failed", error: "stale lease" };
  if (recorded.data.status === "pending") return { status: "failed", error: "provider retry" };
  return { status: "done" };
}
