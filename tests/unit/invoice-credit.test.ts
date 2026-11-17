import { describe, expect, it } from "vitest";

import { creditAmount, creditBackLabel, creditBlockedText, creditFormSchema } from "@/features/invoicing/credit";
import { createInvoiceIssueHandler, requestSchema } from "@/features/invoicing/issue-handler";
import { clearFakeInvoices, createFakeInvoiceProvider, fakeCustomerUpserts, fakeIssueCalls, fakeIssuedDocuments, fakeLookupCalls } from "@/features/invoicing/providers/fake";
import { canIssueCredits, canIssueDocuments } from "@/features/permissions/keys";
import { DEFAULT_TERMS } from "@/features/terminology/terms";

// DOC-14: a credit invoice through the invoice provider: the form's rules, who credits, and the worker's credit path.

const stored = {
  doc_type: "credit_invoice" as const,
  doc_date: "2026-11-17",
  due_date: null,
  locale: "he",
  send_email: false,
  original_document_id: "doc-1",
  original_provider_document_id: "fake_doc_0123456789abcdef01234567",
  original_number: "123456789",
  reason: "החזרת סחורה",
  lines: [{ description: "זיכוי חלקי לחשבונית מס 123456789", quantity: 1, unit_price_agorot: 847, discount_agorot: 0, vat_exempt: false }],
  totals: { net_agorot: 847, vat_agorot: 153, total_agorot: 1000, rate_bp: 1800, prices_include_vat: false },
};
const job = { id: "job-k", lease: "lease-k", kind: "invoice.issue" as const, organization_id: "org-1", payload: { request_id: "req-k" }, attempt: 1 };

describe("the credit form", () => {
  const base = { key: "7f9c1c6e-6c1e-4f2a-9a55-6c0a3c2b1d10", mode: "partial", amount: "10", reason: "טעות במחיר" };

  it("needs a reason of 1..500 characters on one line", () => {
    expect(creditFormSchema.safeParse(base).success).toBe(true);
    expect(creditFormSchema.safeParse({ ...base, reason: "  " }).success).toBe(false);
    expect(creditFormSchema.safeParse({ ...base, reason: "x".repeat(501) }).success).toBe(false);
    expect(creditFormSchema.safeParse({ ...base, reason: "שורה\nשנייה" }).success).toBe(false);
    expect(creditFormSchema.safeParse({ ...base, mode: "most" }).success).toBe(false);
  });

  it("full sends no amount (everything left); partial is whole agorot above zero and not over what is left", () => {
    expect(creditAmount("full", "", 5000)).toEqual({ ok: true, agorot: null });
    expect(creditAmount("partial", "12.5", 5000)).toEqual({ ok: true, agorot: 1250 });
    expect(creditAmount("partial", "0", 5000).ok).toBe(false);
    expect(creditAmount("partial", "abc", 5000).ok).toBe(false);
    expect(creditAmount("partial", "50.01", 5000).ok).toBe(false);
    // the server does not know what is left: the database judges it
    expect(creditAmount("partial", "50.01", null)).toEqual({ ok: true, agorot: 5001 });
  });

  it("says why a document is not credited here, and names the way back in the business's terms", () => {
    for (const code of ["type", "cancelled", "not_issued_here", "provider", "nothing_left"]) expect(creditBlockedText(code)).not.toBe(creditBlockedText(null));
    expect(creditBackLabel("deal", DEFAULT_TERMS)).toBe("חזרה לעסקה");
    expect(creditBackLabel("contact", DEFAULT_TERMS)).toBe("חזרה לאיש הקשר");
  });
});

describe("who credits", () => {
  it("owners and admins always; managers and members only with issue_credits; issuing alone does not credit", () => {
    expect(canIssueCredits("owner", [])).toBe(true);
    expect(canIssueCredits("admin", [])).toBe(true);
    expect(canIssueCredits("manager", [])).toBe(false);
    expect(canIssueCredits("member", ["issue_documents"])).toBe(false);
    expect(canIssueDocuments("member", ["issue_documents"])).toBe(true);
    expect(canIssueCredits("member", ["issue_credits"])).toBe(true);
    expect(canIssueCredits("viewer", ["issue_credits"])).toBe(false);
    expect(canIssueCredits(null, ["issue_credits"])).toBe(false);
  });
});

describe("the worker's credit path", () => {
  it("a stored credit request parses as a credit", () => {
    const parsed = requestSchema.safeParse(stored);
    expect(parsed.success && parsed.data.doc_type).toBe("credit_invoice");
  });

  it("asks creditDocument with the request id as its key, never the customer; the answer is recorded", async () => {
    clearFakeInvoices();
    const sent: Record<string, unknown>[] = [];
    const handler = createInvoiceIssueHandler({
      provider: createFakeInvoiceProvider(),
      calls: { claim: async () => ({ request_id: "req-k", provider: "fake", request: stored }), record: async (_j, r) => (sent.push(r), { status: "issued" }) },
    });
    expect(await handler(job)).toEqual({ status: "done" });
    expect(fakeCustomerUpserts()).toBe(0);
    expect(fakeIssueCalls()).toBe(1);
    const [credit] = fakeIssuedDocuments();
    expect(credit).toMatchObject({ type: "credit_invoice", totalAgorot: 1000 });
    expect(sent).toEqual([{ ok: true, provider_document_id: credit.providerDocumentId, number: credit.number, allocation: { status: "not_needed" } }]);
    // a retry with the same key reaches the same credit
    await handler(job);
    expect(fakeIssuedDocuments()).toHaveLength(1);
  });

  it("an original the provider does not know is a final refusal; a late claim only looks the credit up", async () => {
    clearFakeInvoices();
    const sent: Record<string, unknown>[] = [];
    const unknown = { ...stored, original_provider_document_id: "other_provider_doc" };
    const handler = createInvoiceIssueHandler({
      provider: createFakeInvoiceProvider(),
      calls: { claim: async () => ({ request_id: "req-k", provider: "fake", request: unknown }), record: async (_j, r) => (sent.push(r), { status: "failed" }) },
    });
    await handler(job);
    expect(sent).toEqual([{ ok: false, code: "original_not_found", final: true }]);
    const late = createInvoiceIssueHandler({
      provider: createFakeInvoiceProvider(),
      calls: { claim: async () => ({ request_id: "req-k", provider: "fake", request: stored, late: true }), record: async () => ({ status: "unrecorded" }) },
    });
    const before = fakeIssueCalls();
    await late(job);
    expect(fakeIssueCalls()).toBe(before);
    expect(fakeLookupCalls()).toBe(1);
  });
});
