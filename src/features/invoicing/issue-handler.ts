// DOC-07 / DOC-09 (owner (398) א): the OPS-04 handler of invoice.issue. Pure of the database: it gets the two worker calls
// (public.invoice_issue_claim and public.invoice_issue_record, service_role, on the job's live lease) and the invoice
// provider, and asks the provider for the stored request with the request's id as the provider's idempotency key, so a
// retry never issues twice. Every check lives in the claim; the queue holds the request's id only.

import { z } from "zod";

import type { ClaimedJob, JobHandler } from "@/features/jobs/registry";

import { ISSUABLE_DOCUMENT_TYPES, type CreditRequest, type InvoiceProvider, type IssueRequest } from "./providers/types";

export const PROVIDER_TIMEOUT_MS = 10_000;

const linesSchema = z.array(
  z.object({
    description: z.string(),
    quantity: z.number(),
    unit_price_agorot: z.number(),
    discount_agorot: z.number(),
    vat_exempt: z.boolean(),
    // owner (410) ב: the product the line came from (a product of this business)
    product_id: z.string().nullable().optional(),
  }),
);

const productSchema = z.object({
  external_ref: z.string(),
  name: z.string(),
  sku: z.string().nullable(),
  unit: z.string().nullable(),
  price_agorot: z.number(),
  price_includes_vat: z.boolean(),
  vat_exempt: z.boolean(),
});
const totalsSchema = z.object({
  net_agorot: z.number(),
  vat_agorot: z.number(),
  total_agorot: z.number(),
  rate_bp: z.number(),
  prices_include_vat: z.boolean(),
});

/** DOC-07: a document to issue, as the database stored it. */
export const issueRequestSchema = z.object({
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
  lines: linesSchema,
  totals: totalsSchema,
});

/** DOC-14: a credit invoice against one of our provider's documents, as the database stored it (migration invoice_credit). */
export const creditRequestSchema = z.object({
  doc_type: z.literal("credit_invoice"),
  doc_date: z.string(),
  original_provider_document_id: z.string(),
  reason: z.string(),
  lines: linesSchema,
  totals: totalsSchema,
});

export const requestSchema = z.union([issueRequestSchema, creditRequestSchema]);

const claimSchema = z.union([
  z.object({ refused: z.string().regex(/^[a-z_:]{1,40}$/) }).passthrough(),
  z.object({
    request_id: z.string(),
    provider: z.string(),
    request: requestSchema,
    late: z.boolean().optional(),
    // DOC-13: the provider's customer id kept for this customer, and whether it was made with the details sent now
    provider_customer: z.object({ id: z.string(), current: z.boolean() }).nullable().optional(),
    // owner (410) ב: the products the lines name, our details, and the provider's kept id with whether it is current
    provider_products: z
      .array(z.object({ product_id: z.string(), product: productSchema, kept: z.object({ id: z.string(), current: z.boolean() }).nullable() }))
      .optional(),
  }),
]);

const recordSchema = z.object({ status: z.enum(["issued", "unrecorded", "failed", "pending", "stale"]) }).passthrough();

/** The provider's request, from the database's stored request (never from the browser). */
export function providerRequest(requestId: string, stored: z.infer<typeof issueRequestSchema>, productIds?: ReadonlyMap<string, string>): IssueRequest {
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
      ...(line.product_id && productIds?.has(line.product_id) ? { providerProductId: productIds.get(line.product_id) } : {}),
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

/** DOC-14: the provider's credit request, from the stored credit request (never from the browser). */
export function providerCreditRequest(requestId: string, stored: z.infer<typeof creditRequestSchema>): CreditRequest {
  return {
    idempotencyKey: requestId,
    originalProviderDocumentId: stored.original_provider_document_id,
    date: stored.doc_date,
    reason: stored.reason,
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
    const timeoutMs = deps.timeoutMs ?? PROVIDER_TIMEOUT_MS;

    // DOC-13: the customer at the provider, made or updated with OUR details whenever nothing is kept for them or the kept id
    // was made with other details (Mexuz is the source); the id it answers is kept by the record, also when the document
    // then fails. A lookup (late) asks nothing about the customer.
    const stored = answer.request;
    let providerCustomerId: string | null = null;
    let customerKept: string | null = null;
    // a credit names the provider's original, which holds its customer: nothing is asked about the customer
    if (!late && stored.doc_type !== "credit_invoice") {
      const kept = answer.provider_customer ?? null;
      if (kept && kept.current) {
        providerCustomerId = kept.id;
      } else {
        const request = providerRequest(answer.request_id, stored);
        let upserted: Awaited<ReturnType<InvoiceProvider["upsertCustomer"]>> | "timeout" | "unreachable";
        try {
          upserted = await withTimeout(deps.provider.upsertCustomer(request.customer), timeoutMs);
        } catch {
          upserted = "unreachable";
        }
        if (upserted === "timeout" || upserted === "unreachable" || !upserted.ok) {
          // nothing was issued in this try; the record's rules decide as for any provider failure (the queue tries again on
          // a retryable one, with the same key)
          return finish(await deps.calls.record(job, upsertFailure("customer", upserted)));
        }
        providerCustomerId = upserted.providerCustomerId;
        customerKept = upserted.providerCustomerId;
      }
    }

    // owner (410) ב: each product a line names, made or updated with OUR details when nothing is kept or the kept id is
    // stale; a failure is a failed try like the customer's (an id already got in this try is still kept)
    const productIds = new Map<string, string>();
    const productsKept: Record<string, string> = {};
    if (!late && stored.doc_type !== "credit_invoice") {
      for (const item of answer.provider_products ?? []) {
        if (item.kept && item.kept.current) {
          productIds.set(item.product_id, item.kept.id);
          continue;
        }
        let upserted: Awaited<ReturnType<InvoiceProvider["upsertProduct"]>> | "timeout" | "unreachable";
        try {
          upserted = await withTimeout(
            deps.provider.upsertProduct({
              externalRef: item.product.external_ref,
              name: item.product.name,
              sku: item.product.sku,
              unit: item.product.unit,
              priceAgorot: item.product.price_agorot,
              priceIncludesVat: item.product.price_includes_vat,
              vatExempt: item.product.vat_exempt,
            }),
            timeoutMs,
          );
        } catch {
          upserted = "unreachable";
        }
        if (upserted === "timeout" || upserted === "unreachable" || !upserted.ok) {
          return finish(await deps.calls.record(job, withKept(upsertFailure("product", upserted), customerKept, productsKept)));
        }
        productIds.set(item.product_id, upserted.providerProductId);
        productsKept[item.product_id] = upserted.providerProductId;
      }
    }

    const call = late
      ? deps.provider.findDocument(answer.request_id)
      : stored.doc_type === "credit_invoice"
        ? deps.provider.creditDocument(providerCreditRequest(answer.request_id, stored))
        : deps.provider.issueDocument({ ...providerRequest(answer.request_id, stored, productIds), providerCustomerId });
    let issued: Awaited<ReturnType<InvoiceProvider["issueDocument"]>> | "timeout" | "unreachable";
    try {
      issued = await withTimeout(call, timeoutMs);
    } catch {
      // the adapter threw (no connection): nothing is known to have happened, as after a timeout; told apart in the code only
      issued = "unreachable";
    }
    const answered: Record<string, unknown> =
      issued === "timeout" || issued === "unreachable"
        ? { ok: false, code: issued, final: false }
        : issued.ok
          ? {
              ok: true,
              provider_document_id: issued.document.providerDocumentId,
              number: issued.document.number,
              // DOC-10: the provider's allocation outcome as it answered it (the database keeps the closed list's codes only)
              allocation: issued.document.allocation,
            }
          : late && issued.code === "not_found"
            ? { ok: false, code: "not_at_provider", final: true }
            : { ok: false, code: issued.code, final: issued.kind !== "retry" };
    const result = withKept(answered, customerKept, productsKept);
    return finish(await deps.calls.record(job, result));
  };
}

/** A failed customer or product upsert, as the record takes a provider failure (nothing was issued in this try). */
function upsertFailure(what: "customer" | "product", upserted: "timeout" | "unreachable" | { ok: false; kind: "retry" | "refused" | "auth"; code: string }): Record<string, unknown> {
  return typeof upserted === "string"
    ? { ok: false, code: `${what}_${upserted}`, final: false }
    : { ok: false, code: `${what}_${upserted.code}`.slice(0, 64), final: upserted.kind !== "retry" };
}

/** The answer with the provider ids this try got (the record keeps them whatever the document's outcome). */
function withKept(answer: Record<string, unknown>, customer: string | null, products: Record<string, string>): Record<string, unknown> {
  return {
    ...answer,
    ...(customer === null ? {} : { provider_customer_id: customer }),
    ...(Object.keys(products).length === 0 ? {} : { provider_product_ids: products }),
  };
}

/** The job's outcome from the record's answer. */
function finish(answer: unknown): Awaited<ReturnType<JobHandler>> {
  const recorded = recordSchema.safeParse(answer);
  if (!recorded.success) return { status: "failed", error: "record answered an unexpected shape" };
  const status = recorded.data.status;
  if (status === "stale") return { status: "failed", error: "stale lease" };
  // nothing is known to have happened at the provider: the queue tries again with the same key
  if (status === "pending") return { status: "failed", error: "provider retry" };
  return { status: "done" };
}
