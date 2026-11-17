import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ALLOCATION_FAILURE_LABELS, allocationFailureReason, allocationFailureText } from "@/features/documents/allocation";
import { DOCUMENT_SORT_COLUMNS } from "@/features/documents/list";
import { createInvoiceIssueHandler } from "@/features/invoicing/issue-handler";
import { clearFakeInvoices, createFakeInvoiceProvider } from "@/features/invoicing/providers/fake";
import { ALLOCATION_FAILURE_CODES } from "@/features/invoicing/providers/types";
import { catalogFor } from "@/features/list-columns/columns";

// DOC-10: the provider's allocation outcome travels to the database as it answered it, and the documents show the number or
// the mark with the reason. The closed list of codes is the same in TypeScript and in the migration.

const migration = () => {
  const dir = join(process.cwd(), "supabase/migrations");
  const file = readdirSync(dir).find((name) => name.endsWith("_allocation_failure.sql"));
  if (!file) throw new Error("the DOC-10 migration is missing");
  return readFileSync(join(dir, file), "utf8");
};

describe("the closed list of allocation failure codes", () => {
  it("is the migration's list, in its function and in its constraint", () => {
    const sql = migration();
    const fn = /app\.allocation_failure_codes\(\)[\s\S]*?select array\[([^\]]+)\]/.exec(sql);
    const constraint = /allocation_error_code in \(([^)]+)\)/.exec(sql);
    const codes = (text: string | undefined) => [...(text ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(codes(fn?.[1])).toEqual([...ALLOCATION_FAILURE_CODES]);
    expect(codes(constraint?.[1])).toEqual([...ALLOCATION_FAILURE_CODES]);
  });

  it("every code has a Hebrew reason", () => {
    expect(Object.keys(ALLOCATION_FAILURE_LABELS).sort()).toEqual([...ALLOCATION_FAILURE_CODES].sort());
    for (const code of ALLOCATION_FAILURE_CODES) expect(ALLOCATION_FAILURE_LABELS[code]).toMatch(/[א-ת]/);
  });

  it("the system never works out the threshold: the migration compares no amount with anything for the allocation", () => {
    const sql = migration();
    expect(sql).not.toMatch(/amount_agorot\s*[<>]=?/);
    expect(sql).not.toMatch(/total_agorot'\)::bigint\s*[<>]/);
  });
});

describe("the mark on a document", () => {
  it("shows the reason when the provider did not get a number", () => {
    expect(allocationFailureText({ allocationNumber: null, allocationErrorCode: "tax_authority_refused" })).toBe("לא התקבל מספר הקצאה: רשות המסים סירבה לבקשה");
    expect(allocationFailureText({ allocationNumber: null, allocationErrorCode: null })).toBeNull();
    // a number that arrived later wins
    expect(allocationFailureText({ allocationNumber: "123", allocationErrorCode: "other" })).toBeNull();
  });

  it("a code this version does not know reads as 'other', never raw", () => {
    expect(allocationFailureReason("something_new")).toBe(ALLOCATION_FAILURE_LABELS.other);
    expect(allocationFailureReason(null)).toBeNull();
  });

  it("the documents list offers the allocation column and sorts it", () => {
    expect(catalogFor("document", []).map((c) => c.key)).toContain("allocation");
    expect(DOCUMENT_SORT_COLUMNS.allocation).toBe("allocation_number");
  });
});

describe("the worker hands the outcome on", () => {
  const stored = {
    doc_type: "tax_invoice" as const,
    doc_date: "2026-11-17",
    due_date: null,
    locale: "he" as const,
    send_email: false,
    customer: { external_ref: "contact:1", name: "דנה", tax_id: null, address: null, email: null, is_business: false },
    lines: [{ description: "x", quantity: 1, unit_price_agorot: 100, discount_agorot: 0, vat_exempt: false }],
    totals: { net_agorot: 100, vat_agorot: 0, total_agorot: 100, rate_bp: 0, prices_include_vat: false },
  };
  const job = { id: "job-1", lease: "lease-1", kind: "invoice.issue" as const, organization_id: "org-1", payload: { request_id: "req-a" }, attempt: 1 };

  const recordedWith = async (options: Parameters<typeof createFakeInvoiceProvider>[0], requestId: string) => {
    clearFakeInvoices();
    const recorded: Record<string, unknown>[] = [];
    const handler = createInvoiceIssueHandler({
      provider: createFakeInvoiceProvider(options),
      calls: { claim: async () => ({ request_id: requestId, provider: "fake", request: stored }), record: async (_j, r) => (recorded.push(r), { status: "issued" }) },
    });
    expect(await handler(job)).toEqual({ status: "done" });
    return recorded[0];
  };

  it("a number, a failure with its code, or not needed", async () => {
    expect((await recordedWith({}, "req-a")).allocation).toEqual({ status: "allocated", number: expect.stringMatching(/^[0-9]{9}$/) });
    expect((await recordedWith({ allocationFailure: () => "customer_tax_id" }, "req-b")).allocation).toEqual({ status: "failed", code: "customer_tax_id" });
    expect((await recordedWith({ allocationNotNeeded: () => true }, "req-c")).allocation).toEqual({ status: "not_needed" });
  });
});
