// DOC-07 / DOC-09 (owner (398) א): the OPS-04 handler of invoice.issue. Pure of the database: it gets the two worker calls
// (public.invoice_issue_claim and public.invoice_issue_record, service_role, on the job's live lease) and the invoice
// provider, and asks the provider for the stored request with the request's id as the provider's idempotency key, so a
// retry never issues twice. Every check lives in the claim; the queue holds the request's id only.

import { z } from "zod";

import type { ClaimedJob, JobHandler } from "@/features/jobs/registry";

import { ISSUABLE_DOCUMENT_TYPES, type InvoiceProvider, type IssueRequest } from "./providers/types";

export const PROVIDER_TIMEOUT_MS = 10_000;

export const requestSchema = z.object({
  doc_type: z.enum(ISSUABLE_DOCUMENT_TYPES),
  doc_date: z.string(),
  due_date: z.string().nullable(),
  locale: z.enum(["he", "en"]),
  send_email: z.boolean(),
  customer: z.object({
    external_ref: z.string(),
    name: z.string(),
    tax_id: z.string().nullable(),
    address: z.string().nullable(),
    email: z.string().nullable(),
    is_business: z.boolean(),
  }),
  lines: z.array(
    z.object({ description: z.string(), quantity: z.number(), unit_price_agorot: z.number(), discount_agorot: z.number(), vat_exempt: z.boolean() }),
  ),
  totals: z.object({
    net_agorot: z.number(),
    vat_agorot: z.number(),
    total_agorot: z.number(),
    rate_bp: z.number(),
    prices_include_vat: z.boolean(),
  }),
});

const claimSchema = z.union([
  z.object({ refused: z.string().regex(/^[a-z_:]{1,40}$/) }).passthrough(),
  z.object({ request_id: z.string(), provider: z.string(), request: requestSchema, late: z.boolean().optional() }),
]);

const recordSchema = z.object({ status: z.enum(["issued", "unrecorded", "failed", "pending", "stale"]) }).passthrough();

/** The provider's request, from the database's stored request (never from the browser). */
export function providerRequest(requestId: string, stored: z.infer<typeof requestSchema>): IssueRequest {
  return {
    idempotencyKey: requestId,
    type: stored.doc_type,
    date: stored.doc_date,
    dueDate: stored.due_date,
    locale: stored.locale,
    sendEmail: stored.send_email,
    customer: {
      externalRef: stored.customer.external_ref,
      name: stored.customer.name,
      taxId: stored.customer.tax_id,
      address: stored.customer.address,
      email: stored.customer.email,
      isBusiness: stored.customer.is_business,
    },
    lines: stored.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitPriceAgorot: line.unit_price_agorot,
      discountAgorot: line.discount_agorot,
      vatExempt: line.vat_exempt,
    })),
    totals: {
      netAgorot: stored.totals.net_agorot,
      vatAgorot: stored.totals.vat_agorot,
      totalAgorot: stored.totals.total_agorot,
      rateBp: stored.totals.rate_bp,
      pricesIncludeVat: stored.totals.prices_include_vat,
    },
  };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export type InvoiceIssueCalls = {
  claim: (job: ClaimedJob) => Promise<unknown>;
  record: (job: ClaimedJob, result: Record<string, unknown>) => Promise<unknown>;
};

export function createInvoiceIssueHandler(deps: { calls: InvoiceIssueCalls; provider: InvoiceProvider; timeoutMs?: number }): JobHandler {
  return async (job) => {
    const claimed = claimSchema.safeParse(await deps.calls.claim(job));
    if (!claimed.success) return { status: "failed", error: "claim answered an unexpected shape" };
    const answer = claimed.data;
    if ("refused" in answer) {
      if (answer.refused === "stale") return { status: "failed", error: "stale lease" };
      // the request already ended, or the claim ended it: nothing is asked of the provider
      if (answer.refused === "finished") return { status: "done" };
      return { status: "failed", error: `refused ${answer.refused}`, final: true, receipt: { provider: null, errorCode: answer.refused } };
    }
    // the request was made for this provider; another one offered now never issues it: the request ends failed at once
    if (answer.provider !== deps.provider.name) {
      await deps.calls.record(job, { ok: false, code: "provider_changed", final: true });
      return { status: "failed", error: "provider changed", final: true, receipt: { provider: null, errorCode: "provider_changed" } };
    }

    // a request closed or marked stale after an earlier try: LOOKUP ONLY, never a new issue (the same key finds what an
    // earlier try may have made; not found = nothing reached the provider, the closed request stays final)
    const late = answer.late === true;
    const call = late
      ? deps.provider.findDocument(answer.request_id)
      : deps.provider.issueDocument(providerRequest(answer.request_id, answer.request));
    let issued: Awaited<ReturnType<InvoiceProvider["issueDocument"]>> | "timeout" | "unreachable";
    try {
      issued = await withTimeout(call, deps.timeoutMs ?? PROVIDER_TIMEOUT_MS);
    } catch {
      // the adapter threw (no connection): nothing is known to have happened, as after a timeout; told apart in the code only
      issued = "unreachable";
    }
    const result: Record<string, unknown> =
      issued === "timeout" || issued === "unreachable"
        ? { ok: false, code: issued, final: false }
        : issued.ok
          ? {
              ok: true,
              provider_document_id: issued.document.providerDocumentId,
              number: issued.document.number,
              allocation_number: issued.document.allocationNumber,
              allocation_failure: issued.document.allocationFailure,
            }
          : late && issued.code === "not_found"
            ? { ok: false, code: "not_at_provider", final: true }
            : { ok: false, code: issued.code, final: issued.kind !== "retry" };
    const recorded = recordSchema.safeParse(await deps.calls.record(job, result));
    if (!recorded.success) return { status: "failed", error: "record answered an unexpected shape" };
    const status = recorded.data.status;
    if (status === "stale") return { status: "failed", error: "stale lease" };
    // nothing is known to have happened at the provider: the queue tries again with the same key
    if (status === "pending") return { status: "failed", error: "provider retry" };
    return { status: "done" };
  };
}
