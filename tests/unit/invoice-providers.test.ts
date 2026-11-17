import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { clearFakeInvoices, createFakeInvoiceProvider, fakeIssueCalls, fakeIssuedDocuments } from "@/features/invoicing/providers/fake";
import { invoiceProviderFor, invoiceProviderName } from "@/features/invoicing/providers/select";
import type { IssueRequest } from "@/features/invoicing/providers/types";

// DOC-06: one provider interface, the fake adapter, and the selector that refuses the fake on a deployed site.

const root = join(__dirname, "..", "..");

const request = (key: string, patch: Partial<IssueRequest> = {}): IssueRequest => ({
  idempotencyKey: key,
  type: "tax_invoice",
  date: "2026-11-16",
  dueDate: "2026-12-16",
  locale: "he",
  sendEmail: false,
  customer: { externalRef: "contact:1", name: "דנה לוי", taxId: null, address: null, email: null, isBusiness: false },
  lines: [{ description: "ייעוץ", quantity: 1, unitPriceAgorot: 10000, discountAgorot: 0, vatExempt: false }],
  totals: { netAgorot: 10000, vatAgorot: 1800, totalAgorot: 11800, rateBp: 1800, pricesIncludeVat: false },
  ...patch,
});

beforeEach(clearFakeInvoices);

describe("the selector", () => {
  it("offers nothing unless INVOICE_PROVIDER names a built adapter", () => {
    expect(invoiceProviderFor({})).toBeNull();
    expect(invoiceProviderFor({ INVOICE_PROVIDER: "  " })).toBeNull();
    expect(invoiceProviderFor({ INVOICE_PROVIDER: "morning" })).toBeNull();
    expect(invoiceProviderFor({ INVOICE_PROVIDER: "__proto__" })).toBeNull();
    expect(invoiceProviderFor({ INVOICE_PROVIDER: " Fake " })?.name).toBe("fake");
  });

  it("refuses the fake on a production or preview deployment, allows it locally and on development", () => {
    expect(invoiceProviderName({ INVOICE_PROVIDER: "fake", VERCEL_ENV: "production" })).toBeNull();
    expect(invoiceProviderName({ INVOICE_PROVIDER: "fake", VERCEL_ENV: "preview" })).toBeNull();
    expect(invoiceProviderName({ INVOICE_PROVIDER: "fake", VERCEL_ENV: "development" })).toBe("fake");
    expect(invoiceProviderName({ INVOICE_PROVIDER: "fake" })).toBe("fake");
  });

  it("the provider code fits accounting_documents.provider", () => {
    expect(invoiceProviderName({ INVOICE_PROVIDER: "fake" })).toMatch(/^[a-z][a-z0-9_]{1,39}$/);
  });
});

describe("the fake adapter", () => {
  it("the same idempotency key answers the same document (double click, retry after a network failure)", async () => {
    const provider = createFakeInvoiceProvider();
    const first = await provider.issueDocument(request("k-1"));
    const again = await provider.issueDocument(request("k-1"));
    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again.document).toEqual(first.document);
    expect(fakeIssuedDocuments()).toHaveLength(1);
    expect(fakeIssueCalls()).toBe(2);
    // a restart forgets the memory but not the derivation: the same key gives the same number and id
    clearFakeInvoices();
    const later = await provider.issueDocument(request("k-1"));
    expect(later.ok && later.document.providerDocumentId).toBe(first.document.providerDocumentId);
    expect(later.ok && later.document.number).toBe(first.document.number);
  });

  it("two keys make two documents with different numbers and ids", async () => {
    const provider = createFakeInvoiceProvider();
    const a = await provider.issueDocument(request("k-a"));
    const b = await provider.issueDocument(request("k-b"));
    if (!a.ok || !b.ok) throw new Error("issue failed");
    expect(a.document.number).not.toBe(b.document.number);
    expect(a.document.providerDocumentId).not.toBe(b.document.providerDocumentId);
    expect(a.document.number).toMatch(/^[1-9][0-9]{8}$/);
    expect(a.document.providerDocumentId).toMatch(/^fake_doc_[0-9a-f]{24}$/);
  });

  it("DOC-10: a tax invoice gets an allocation number, a receipt or a proforma none needed; a refused allocation answers its code", async () => {
    const provider = createFakeInvoiceProvider({
      allocationFailure: (r) => (r.idempotencyKey === "k-no" ? "tax_authority_refused" : null),
      allocationNotNeeded: (r) => r.idempotencyKey === "k-small",
    });
    const invoice = await provider.issueDocument(request("k-inv"));
    const receipt = await provider.issueDocument(request("k-rec", { type: "receipt" }));
    const proforma = await provider.issueDocument(request("k-pro", { type: "proforma" }));
    const refused = await provider.issueDocument(request("k-no", { type: "tax_invoice_receipt" }));
    const small = await provider.issueDocument(request("k-small"));
    if (!invoice.ok || !receipt.ok || !proforma.ok || !refused.ok || !small.ok) throw new Error("issue failed");
    expect(invoice.document.allocation).toEqual({ status: "allocated", number: expect.stringMatching(/^[0-9]{9}$/) });
    expect(receipt.document.allocation).toEqual({ status: "not_needed" });
    expect(proforma.document.allocation).toEqual({ status: "not_needed" });
    expect(refused.document.allocation).toEqual({ status: "failed", code: "tax_authority_refused" });
    // the provider judged the threshold: the system keeps its word
    expect(small.document.allocation).toEqual({ status: "not_needed" });
  });

  it("a failure is answered, never thrown, and keeps nothing", async () => {
    const provider = createFakeInvoiceProvider({ fail: () => ({ ok: false, kind: "retry", code: "timeout" }) });
    expect(await provider.issueDocument(request("k-f"))).toEqual({ ok: false, kind: "retry", code: "timeout" });
    expect(fakeIssuedDocuments()).toHaveLength(0);
  });

  it("reads, lists, credits; verifies no webhook", async () => {
    const provider = createFakeInvoiceProvider();
    const issued = await provider.issueDocument(request("k-r"));
    if (!issued.ok) throw new Error("issue failed");
    const read = await provider.getDocument(issued.document.providerDocumentId);
    expect(read.ok && read.document.number).toBe(issued.document.number);
    expect((await provider.getDocument("nope")).ok).toBe(false);
    const listed = await provider.listDocumentsSince("2026-11-01");
    expect(listed.ok && listed.documents.map((d) => d.providerDocumentId)).toEqual([issued.document.providerDocumentId]);
    const later = await provider.listDocumentsSince("2026-12-01");
    expect(later.ok && later.documents).toEqual([]);
    const credit = await provider.creditDocument({
      idempotencyKey: "k-c",
      originalProviderDocumentId: issued.document.providerDocumentId,
      date: "2026-11-17",
      reason: "החזר",
      lines: [],
      totals: { netAgorot: 1000, vatAgorot: 180, totalAgorot: 1180, rateBp: 1800, pricesIncludeVat: false },
    });
    expect(credit.ok && credit.document.type).toBe("credit_invoice");
    expect((await provider.checkConnection()).ok).toBe(true);
    expect(await provider.verifyWebhook("{}", {})).toBe(false);
  });
});

describe("the layer stays apart", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
    });

  it("no client component imports the provider layer", () => {
    for (const file of files(join(root, "src"))) {
      const text = readFileSync(file, "utf8");
      if (!/^\s*["']use client["']/.test(text)) continue;
      expect(text, file).not.toMatch(/invoicing\/providers\/(fake|select)/);
    }
  });

  it("INVOICE_PROVIDER is documented in .env.example and is never NEXT_PUBLIC_", () => {
    const example = readFileSync(join(root, ".env.example"), "utf8");
    expect(example).toMatch(/^INVOICE_PROVIDER=$/m);
    expect(example).not.toMatch(/NEXT_PUBLIC_INVOICE_PROVIDER/);
  });
});
