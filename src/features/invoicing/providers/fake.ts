import { createHash } from "node:crypto";

import type { AllocationFailureCode, AllocationOutcome, CreditRequest, InvoiceProvider, IssueRequest, ProviderDocument, ProviderFailure } from "./types";

/**
 * DOC-06: the fake invoice provider (owner (270) (1) א: build behind a fake provider, hidden on the live site until a real
 * adapter exists). It issues nothing anywhere: it keeps what it "issued" in memory of this server process, so a test or a
 * local run can read it back. Numbers and ids are derived from the request's idempotency key (SHA-256), so the same key
 * always answers the same document, also after the process restarts (DOC-09), and two keys never meet in practice.
 * A tax invoice and a tax invoice-receipt get an allocation number unless a test asks for a failure (DOC-10), and every other
 * type answers "not needed" (spec 6.7: the provider decides the threshold, never the system).
 * Chosen only by INVOICE_PROVIDER=fake and never on a production or preview deployment (select.ts).
 */
export const FAKE_PROVIDER = "fake";

type FakeOptions = {
  /** Tests: answer a failure instead of issuing (nothing is kept) */
  fail?: (request: IssueRequest | CreditRequest) => ProviderFailure | null;
  /** Tests (DOC-10): the allocation number is refused on this request, with this code */
  allocationFailure?: (request: IssueRequest) => AllocationFailureCode | null;
  /** Tests (DOC-10): the provider says this request needs no allocation number (it judged the threshold) */
  allocationNotNeeded?: (request: IssueRequest) => boolean;
};

const issued = new Map<string, ProviderDocument>();
const byId = new Map<string, ProviderDocument>();
let calls = 0;
let lookups = 0;

const digest = (key: string) => createHash("sha256").update(`fake-invoice:${key}`, "utf8").digest("hex");
/** 9 digits that never start with 0 */
const digits = (hex: string, from: number) => String(100_000_000 + (parseInt(hex.slice(from, from + 8), 16) % 900_000_000));

/** Tests: what the fake issued in this process */
export function fakeIssuedDocuments(): readonly ProviderDocument[] {
  return [...byId.values()];
}

/** Tests: how many times issueDocument / creditDocument reached the fake (a replayed key counts too) */
export function fakeIssueCalls(): number {
  return calls;
}

/** Tests: how many times findDocument reached the fake */
export function fakeLookupCalls(): number {
  return lookups;
}

export function clearFakeInvoices(): void {
  issued.clear();
  byId.clear();
  calls = 0;
  lookups = 0;
}

function keep(key: string, document: ProviderDocument): ProviderDocument {
  issued.set(key, document);
  byId.set(document.providerDocumentId, document);
  return document;
}

export function createFakeInvoiceProvider(options: FakeOptions = {}): InvoiceProvider {
  return {
    name: FAKE_PROVIDER,
    async checkConnection() {
      return { ok: true };
    },
    async upsertCustomer(customer) {
      return { ok: true, providerCustomerId: `fake_customer_${digest(customer.externalRef).slice(0, 16)}` };
    },
    async issueDocument(request) {
      calls += 1;
      const failure = options.fail?.(request);
      if (failure) return failure;
      const known = issued.get(request.idempotencyKey);
      if (known) return { ok: true, document: known };
      const hex = digest(request.idempotencyKey);
      const allocates = (request.type === "tax_invoice" || request.type === "tax_invoice_receipt") && !options.allocationNotNeeded?.(request);
      const refusal = allocates ? (options.allocationFailure?.(request) ?? null) : null;
      const allocation: AllocationOutcome = !allocates
        ? { status: "not_needed" }
        : refusal !== null
          ? { status: "failed", code: refusal }
          : { status: "allocated", number: digits(hex, 8) };
      return {
        ok: true,
        document: keep(request.idempotencyKey, {
          providerDocumentId: `fake_doc_${hex.slice(0, 24)}`,
          type: request.type,
          number: digits(hex, 0),
          date: request.date,
          totalAgorot: request.totals.totalAgorot,
          allocation,
          customerRef: request.customer.externalRef,
        }),
      };
    },
    async findDocument(idempotencyKey) {
      lookups += 1;
      const document = issued.get(idempotencyKey);
      return document ? { ok: true, document } : { ok: false, kind: "refused", code: "not_found" };
    },
    async getDocument(providerDocumentId) {
      const document = byId.get(providerDocumentId);
      return document ? { ok: true, document } : { ok: false, kind: "refused", code: "not_found" };
    },
    async listDocumentsSince(date) {
      return { ok: true, documents: [...byId.values()].filter((d) => d.date >= date) };
    },
    async creditDocument(request) {
      calls += 1;
      const failure = options.fail?.(request);
      if (failure) return failure;
      const known = issued.get(request.idempotencyKey);
      if (known) return { ok: true, document: known };
      if (!byId.has(request.originalProviderDocumentId)) return { ok: false, kind: "refused", code: "original_not_found" };
      const hex = digest(request.idempotencyKey);
      return {
        ok: true,
        document: keep(request.idempotencyKey, {
          providerDocumentId: `fake_doc_${hex.slice(0, 24)}`,
          type: "credit_invoice",
          number: digits(hex, 0),
          date: request.date,
          totalAgorot: request.totals.totalAgorot,
          allocation: { status: "not_needed" },
          customerRef: byId.get(request.originalProviderDocumentId)?.customerRef ?? null,
        }),
      };
    },
    async pdfLink(providerDocumentId) {
      return byId.has(providerDocumentId) ? { ok: false, kind: "refused", code: "fake_has_no_pdf" } : { ok: false, kind: "refused", code: "not_found" };
    },
    async verifyWebhook() {
      // the fake sends no webhooks: nothing it is shown is genuine
      return false;
    },
  };
}
