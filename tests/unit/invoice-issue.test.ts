import { describe, expect, it } from "vitest";

import {
  agorotText,
  customerProblemsText,
  issuableTypesFor,
  issueFormSchema,
  issueLineFrom,
  issueTakesDueDate,
  parseIssueLines,
  sourceLineDiscount,
} from "@/features/invoicing/issue";
import { createInvoiceIssueHandler, providerRequest } from "@/features/invoicing/issue-handler";
import { clearFakeInvoices, createFakeInvoiceProvider, fakeCustomers, fakeCustomerUpserts, fakeIssueCalls, fakeLookupCalls } from "@/features/invoicing/providers/fake";
import { canIssueDocuments } from "@/features/permissions/keys";

// DOC-07 / DOC-08 / DOC-17: the issue form's rules (the database judges again, migration invoice_issue).

describe("lines", () => {
  const draft = (patch: Partial<Record<string, string | boolean>> = {}) => ({ description: "ייעוץ", quantity: "2", unitPrice: "100", discount: "", vatExempt: false, ...patch });

  it("reads a typed line into agorot", () => {
    expect(issueLineFrom(draft({ unitPrice: "1,234.5", discount: "10" }) as never)).toEqual({
      description: "ייעוץ",
      quantity: 2,
      unit_price_agorot: 123450,
      discount_agorot: 1000,
      vat_exempt: false,
    });
  });

  it("refuses an empty description, a bad quantity or price, a discount above the line, a control character", () => {
    expect(issueLineFrom(draft({ description: "  " }) as never)).toBeNull();
    expect(issueLineFrom(draft({ quantity: "0" }) as never)).toBeNull();
    expect(issueLineFrom(draft({ quantity: "1.0001" }) as never)).toBeNull();
    expect(issueLineFrom(draft({ unitPrice: "abc" }) as never)).toBeNull();
    expect(issueLineFrom(draft({ discount: "500" }) as never)).toBeNull();
    expect(issueLineFrom(draft({ description: "a\u0007b" }) as never)).toBeNull();
  });

  it("parses the hidden field: 1..200 valid rows, else a message naming the row", () => {
    expect(parseIssueLines("[]")).toEqual({ ok: false, message: "במסמך צריכה להיות לפחות שורה אחת." });
    expect(parseIssueLines("not json").ok).toBe(false);
    const bad = parseIssueLines(JSON.stringify([draft(), draft({ quantity: "-1" })]));
    expect(bad.ok === false && bad.message).toContain("בשורה 2");
    const good = parseIssueLines(JSON.stringify([draft(), draft({ vatExempt: true })]));
    expect(good.ok && good.lines.map((l) => l.vat_exempt)).toEqual([false, true]);
    expect(parseIssueLines(JSON.stringify(Array.from({ length: 201 }, () => draft()))).ok).toBe(false);
  });

  it("a source line's discount: its agorot, else its basis points on the line half up", () => {
    expect(sourceLineDiscount({ quantity: 1, unit_price_agorot: 1000, discount_bp: null, discount_agorot: 250 })).toBe(250);
    expect(sourceLineDiscount({ quantity: 3, unit_price_agorot: 333, discount_bp: 1000, discount_agorot: null })).toBe(100);
    expect(sourceLineDiscount({ quantity: 1, unit_price_agorot: 1000, discount_bp: null, discount_agorot: null })).toBe(0);
    expect(agorotText(123450)).toBe("1234.50");
    expect(agorotText(10000)).toBe("100");
  });
});

describe("the form", () => {
  it("takes an issuable type, a date and a key; a due date only on a tax invoice or a proforma", () => {
    const key = "11111111-2222-4333-8444-555555555555";
    expect(issueFormSchema.safeParse({ doc_type: "tax_invoice", doc_date: "2026-11-16", due_date: "", key }).success).toBe(true);
    expect(issueFormSchema.safeParse({ doc_type: "credit_invoice", doc_date: "2026-11-16", due_date: "", key }).success).toBe(false);
    expect(issueFormSchema.safeParse({ doc_type: "receipt", doc_date: "2026-11-16", due_date: "", key: "x" }).success).toBe(false);
    expect(issueTakesDueDate("tax_invoice")).toBe(true);
    expect(issueTakesDueDate("proforma")).toBe(true);
    expect(issueTakesDueDate("receipt")).toBe(false);
    expect(issueTakesDueDate("tax_invoice_receipt")).toBe(false);
  });

  it("DOC-08: every missing part has its own sentence", () => {
    const texts = customerProblemsText(["name", "tax_id", "address", "other"]);
    expect(texts).toHaveLength(4);
    expect(new Set(texts).size).toBe(4);
  });
});

describe("types by VAT status", () => {
  it("a business that charges no VAT is offered no tax invoice; an unknown status is offered all", () => {
    expect(issuableTypesFor(false)).toEqual(["receipt", "proforma"]);
    expect(issuableTypesFor(true)).toHaveLength(4);
    expect(issuableTypesFor(null)).toHaveLength(4);
  });
});

describe("DOC-17: who issues", () => {
  it("owners and admins always; managers and members only with the key; never a viewer", () => {
    expect(canIssueDocuments("owner", [])).toBe(true);
    expect(canIssueDocuments("admin", [])).toBe(true);
    expect(canIssueDocuments("manager", [])).toBe(false);
    expect(canIssueDocuments("manager", ["issue_documents"])).toBe(true);
    expect(canIssueDocuments("member", ["issue_documents"])).toBe(true);
    expect(canIssueDocuments("viewer", ["issue_documents"])).toBe(false);
    expect(canIssueDocuments(null, [])).toBe(false);
  });
});

describe("the provider's request comes from the stored request", () => {
  it("maps the database's request one to one, the request id as the idempotency key", () => {
    const request = providerRequest("req-1", {
      doc_type: "tax_invoice",
      doc_date: "2026-11-16",
      due_date: null,
      locale: "he",
      send_email: true,
      customer: { external_ref: "contact:1", name: "דנה", tax_id: null, address: null, email: "d@x.co", is_business: false },
      lines: [{ description: "x", quantity: 1, unit_price_agorot: 100, discount_agorot: 10, vat_exempt: false }],
      totals: { net_agorot: 90, vat_agorot: 16, total_agorot: 106, rate_bp: 1800, prices_include_vat: false },
    });
    expect(request.idempotencyKey).toBe("req-1");
    expect(request.lines).toEqual([{ description: "x", quantity: 1, unitPriceAgorot: 100, discountAgorot: 10, vatExempt: false }]);
    expect(request.totals.totalAgorot).toBe(106);
    expect(request.customer.email).toBe("d@x.co");
  });
});

describe("the invoice.issue job handler (owner (398) א)", () => {
  const stored = {
    doc_type: "receipt" as const,
    doc_date: "2026-11-16",
    due_date: null,
    locale: "he" as const,
    send_email: false,
    customer: { external_ref: "contact:1", name: "דנה", tax_id: null, address: null, email: null, is_business: false },
    lines: [{ description: "x", quantity: 1, unit_price_agorot: 100, discount_agorot: 0, vat_exempt: false }],
    totals: { net_agorot: 100, vat_agorot: 0, total_agorot: 100, rate_bp: 0, prices_include_vat: false },
  };
  const job = { id: "job-1", lease: "lease-1", kind: "invoice.issue" as const, organization_id: "org-1", payload: { request_id: "req-1" }, attempt: 1 };

  it("asks the provider with the request id as its key and records the answer", async () => {
    const recorded: Record<string, unknown>[] = [];
    const handler = createInvoiceIssueHandler({
      provider: createFakeInvoiceProvider(),
      calls: {
        claim: async () => ({ request_id: "req-1", provider: "fake", request: stored }),
        record: async (_job, result) => {
          recorded.push(result);
          return { status: "issued" };
        },
      },
    });
    expect(await handler(job)).toEqual({ status: "done" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ ok: true });
    expect(typeof recorded[0].provider_document_id).toBe("string");
    // a retry reaches the same document at the provider
    const again: Record<string, unknown>[] = [];
    const retry = createInvoiceIssueHandler({
      provider: createFakeInvoiceProvider(),
      calls: { claim: async () => ({ request_id: "req-1", provider: "fake", request: stored }), record: async (_j, r) => (again.push(r), { status: "issued" }) },
    });
    await retry(job);
    expect(again[0].provider_document_id).toBe(recorded[0].provider_document_id);
  });

  it("a refusal of the claim asks nothing of the provider and ends the job", async () => {
    let asked = 0;
    const provider = { ...createFakeInvoiceProvider(), issueDocument: async () => ((asked += 1), { ok: false as const, kind: "retry" as const, code: "x" }) };
    const handler = createInvoiceIssueHandler({ provider, calls: { claim: async () => ({ refused: "requester_gone" }), record: async () => ({ status: "issued" }) } });
    expect(await handler(job)).toMatchObject({ status: "failed", final: true, receipt: { provider: null, errorCode: "requester_gone" } });
    const finished = createInvoiceIssueHandler({ provider, calls: { claim: async () => ({ refused: "finished", status: "issued" }), record: async () => ({}) } });
    expect(await finished(job)).toEqual({ status: "done" });
    expect(asked).toBe(0);
  });

  it("a provider's retryable failure is recorded as not final and the queue tries again; a refusal is final", async () => {
    const results: Record<string, unknown>[] = [];
    const make = (kind: "retry" | "refused") =>
      createInvoiceIssueHandler({
        provider: { ...createFakeInvoiceProvider(), issueDocument: async () => ({ ok: false as const, kind, code: "busy" }) },
        calls: {
          // DOC-13: a customer kept with these details, so nothing but the document is asked
          claim: async () => ({ request_id: "req-1", provider: "fake", request: stored, provider_customer: { id: "fake_customer_x", current: true } }),
          record: async (_j, r) => (results.push(r), { status: kind === "retry" ? "pending" : "failed" }),
        },
      });
    expect(await make("retry")(job)).toMatchObject({ status: "failed" });
    expect(results[0]).toEqual({ ok: false, code: "busy", final: false });
    expect(await make("refused")(job)).toEqual({ status: "done" });
    expect(results[1]).toEqual({ ok: false, code: "busy", final: true });
  });

  it("another provider offered now never issues an old request: the request ends failed at once", async () => {
    const sent: Record<string, unknown>[] = [];
    const handler = createInvoiceIssueHandler({
      provider: createFakeInvoiceProvider(),
      calls: { claim: async () => ({ request_id: "req-1", provider: "other", request: stored }), record: async (_j, r) => (sent.push(r), { status: "failed" }) },
    });
    expect(await handler(job)).toMatchObject({ status: "failed", final: true });
    expect(sent).toEqual([{ ok: false, code: "provider_changed", final: true }]);
  });
});

describe("DOC-13: the customer at the provider", () => {
  const stored = {
    doc_type: "tax_invoice" as const,
    doc_date: "2026-11-16",
    due_date: null,
    locale: "he" as const,
    send_email: false,
    customer: { external_ref: "contact:7", name: "דנה לוי", tax_id: null, address: "הרצל 1", email: "d@example.com", is_business: false },
    lines: [{ description: "x", quantity: 1, unit_price_agorot: 100, discount_agorot: 0, vat_exempt: false }],
    totals: { net_agorot: 100, vat_agorot: 18, total_agorot: 118, rate_bp: 1800, prices_include_vat: false },
  };
  const job = { id: "job-c", lease: "lease-c", kind: "invoice.issue" as const, organization_id: "org-1", payload: { request_id: "req-c" }, attempt: 1 };
  const spy = () => {
    const base = createFakeInvoiceProvider();
    const issuedWith: (string | null | undefined)[] = [];
    return {
      issuedWith,
      provider: {
        ...base,
        issueDocument: async (request: Parameters<typeof base.issueDocument>[0]) => (issuedWith.push(request.providerCustomerId), base.issueDocument(request)),
      },
    };
  };

  it("nothing kept: the customer is made with our details first, and its id goes to the document and to the record", async () => {
    clearFakeInvoices();
    const { provider, issuedWith } = spy();
    const sent: Record<string, unknown>[] = [];
    const handler = createInvoiceIssueHandler({
      provider,
      calls: { claim: async () => ({ request_id: "req-c", provider: "fake", request: stored, provider_customer: null }), record: async (_j, r) => (sent.push(r), { status: "issued" }) },
    });
    expect(await handler(job)).toEqual({ status: "done" });
    expect(fakeCustomerUpserts()).toBe(1);
    const held = fakeCustomers().get("contact:7");
    expect(held?.customer).toMatchObject({ name: "דנה לוי", address: "הרצל 1", email: "d@example.com" });
    expect(issuedWith).toEqual([held?.id]);
    expect(sent[0]).toMatchObject({ ok: true, provider_customer_id: held?.id });
  });

  it("kept with the same details: no customer call, the kept id is used and nothing new is kept", async () => {
    clearFakeInvoices();
    const { provider, issuedWith } = spy();
    const sent: Record<string, unknown>[] = [];
    const handler = createInvoiceIssueHandler({
      provider,
      calls: {
        claim: async () => ({ request_id: "req-c", provider: "fake", request: stored, provider_customer: { id: "fake_customer_kept", current: true } }),
        record: async (_j, r) => (sent.push(r), { status: "issued" }),
      },
    });
    await handler(job);
    expect(fakeCustomerUpserts()).toBe(0);
    expect(issuedWith).toEqual(["fake_customer_kept"]);
    expect(sent[0]).not.toHaveProperty("provider_customer_id");
  });

  it("kept with other details: our details are sent again (Mexuz wins)", async () => {
    clearFakeInvoices();
    const { provider } = spy();
    const handler = createInvoiceIssueHandler({
      provider,
      calls: {
        claim: async () => ({ request_id: "req-c", provider: "fake", request: stored, provider_customer: { id: "fake_customer_old", current: false } }),
        record: async () => ({ status: "issued" }),
      },
    });
    await handler(job);
    expect(fakeCustomerUpserts()).toBe(1);
    expect(fakeCustomers().get("contact:7")?.customer.name).toBe("דנה לוי");
  });

  it("the customer call fails: no document is asked; a retryable failure is tried again, a refusal is final", async () => {
    for (const kind of ["retry", "refused"] as const) {
      clearFakeInvoices();
      const sent: Record<string, unknown>[] = [];
      const handler = createInvoiceIssueHandler({
        provider: createFakeInvoiceProvider({ failCustomer: () => ({ ok: false, kind, code: "bad_customer" }) }),
        calls: {
          claim: async () => ({ request_id: "req-c", provider: "fake", request: stored }),
          record: async (_j, r) => (sent.push(r), { status: kind === "retry" ? "pending" : "failed" }),
        },
      });
      expect(await handler(job)).toEqual(kind === "retry" ? { status: "failed", error: "provider retry" } : { status: "done" });
      expect(sent).toEqual([{ ok: false, code: "customer_bad_customer", final: kind !== "retry" }]);
      expect(fakeIssueCalls()).toBe(0);
    }
  });

  it("a late lookup asks nothing about the customer", async () => {
    clearFakeInvoices();
    const handler = createInvoiceIssueHandler({
      provider: createFakeInvoiceProvider(),
      calls: { claim: async () => ({ request_id: "req-c", provider: "fake", request: stored, late: true }), record: async () => ({ status: "unrecorded" }) },
    });
    await handler(job);
    expect(fakeCustomerUpserts()).toBe(0);
  });
});

describe("a late claim only looks the document up (third review)", () => {
  const stored = {
    doc_type: "receipt" as const,
    doc_date: "2026-11-16",
    due_date: null,
    locale: "he" as const,
    send_email: false,
    customer: { external_ref: "contact:1", name: "דנה", tax_id: null, address: null, email: null, is_business: false },
    lines: [{ description: "x", quantity: 1, unit_price_agorot: 100, discount_agorot: 0, vat_exempt: false }],
    totals: { net_agorot: 100, vat_agorot: 0, total_agorot: 100, rate_bp: 0, prices_include_vat: false },
  };
  const job = { id: "job-9", lease: "lease-9", kind: "invoice.issue" as const, organization_id: "org-1", payload: { request_id: "req-9" }, attempt: 2 };
  const late = async () => ({ request_id: "req-9", provider: "fake", request: stored, late: true });

  it("not found at the provider: nothing is issued and the request stays final", async () => {
    clearFakeInvoices();
    const sent: Record<string, unknown>[] = [];
    const handler = createInvoiceIssueHandler({ provider: createFakeInvoiceProvider(), calls: { claim: late, record: async (_j, r) => (sent.push(r), { status: "unrecorded" }) } });
    expect(await handler(job)).toEqual({ status: "done" });
    expect(sent).toEqual([{ ok: false, code: "not_at_provider", final: true }]);
    expect(fakeIssueCalls()).toBe(0);
    expect(fakeLookupCalls()).toBe(1);
  });

  it("an earlier try issued it: the lookup finds the same document and it is recorded", async () => {
    clearFakeInvoices();
    const provider = createFakeInvoiceProvider();
    const first = await provider.issueDocument(providerRequest("req-9", stored));
    const calls = fakeIssueCalls();
    const sent: Record<string, unknown>[] = [];
    const handler = createInvoiceIssueHandler({ provider, calls: { claim: late, record: async (_j, r) => (sent.push(r), { status: "issued" }) } });
    expect(await handler(job)).toEqual({ status: "done" });
    expect(first.ok && sent[0].provider_document_id === first.document.providerDocumentId).toBe(true);
    expect(fakeIssueCalls()).toBe(calls);
  });

  it("a lookup without an answer, or an adapter that cannot connect, is retried, never final", async () => {
    const sent: Record<string, unknown>[] = [];
    const slow = { ...createFakeInvoiceProvider(), findDocument: () => new Promise<never>(() => {}) };
    const handler = createInvoiceIssueHandler({ provider: slow, timeoutMs: 5, calls: { claim: late, record: async (_j, r) => (sent.push(r), { status: "pending" }) } });
    expect(await handler(job)).toMatchObject({ status: "failed" });
    const broken = { ...createFakeInvoiceProvider(), findDocument: async () => Promise.reject(new Error("no connection")) };
    const handler2 = createInvoiceIssueHandler({ provider: broken, calls: { claim: late, record: async (_j, r) => (sent.push(r), { status: "pending" }) } });
    expect(await handler2(job)).toMatchObject({ status: "failed" });
    expect(sent).toEqual([
      { ok: false, code: "timeout", final: false },
      { ok: false, code: "unreachable", final: false },
    ]);
  });
});
