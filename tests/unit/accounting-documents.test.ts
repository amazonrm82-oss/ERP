import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { cancelReasonSchema, DOCUMENT_TYPE_LABELS, DOCUMENT_TYPES, documentSchema } from "@/features/documents/schema";
import { canRecordDocuments } from "@/features/permissions/keys";

// DOC-01: the form's rules mirror public.accounting_documents (migration accounting_documents).

const dir = path.join(process.cwd(), "supabase/migrations");
const migration = readFileSync(path.join(dir, readdirSync(dir).find((f) => f.endsWith("_accounting_documents.sql"))!), "utf8");

describe("accounting documents (DOC-01)", () => {
  it("the closed list of types equals the table's check, with the owner's Hebrew names", () => {
    const listed = /doc_type\s+text not null check \(doc_type in \(([^)]*)\)\)/.exec(migration)?.[1] ?? "";
    expect([...listed.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual([...DOCUMENT_TYPES]);
    expect(DOCUMENT_TYPE_LABELS).toEqual({
      tax_invoice: "חשבונית מס",
      tax_invoice_receipt: "חשבונית מס/קבלה",
      receipt: "קבלה",
      credit_invoice: "חשבונית זיכוי",
      proforma: "חשבונית עסקה",
    });
  });

  it("reads the form: a type from the list, a number up to 40, a date and an amount in shekels", () => {
    expect(documentSchema.parse({ doc_type: "receipt", number: " 1001 ", doc_date: "2026-10-20", amount: "1,170.50" })).toEqual({
      doc_type: "receipt",
      number: "1001",
      doc_date: "2026-10-20",
      amount: 117050,
    });
    expect(documentSchema.safeParse({ doc_type: "bill", number: "1", doc_date: "2026-10-20", amount: "1" }).success).toBe(false);
    expect(documentSchema.safeParse({ doc_type: "receipt", number: "x".repeat(41), doc_date: "2026-10-20", amount: "1" }).success).toBe(false);
    expect(documentSchema.safeParse({ doc_type: "receipt", number: "", doc_date: "2026-10-20", amount: "1" }).success).toBe(false);
    expect(documentSchema.safeParse({ doc_type: "receipt", number: "1", doc_date: "2026-02-30", amount: "1" }).success).toBe(false);
    expect(documentSchema.safeParse({ doc_type: "receipt", number: "1", doc_date: "2026-10-20", amount: "" }).success).toBe(false);
    expect(documentSchema.safeParse({ doc_type: "receipt", number: "1", doc_date: "2026-10-20", amount: "-5" }).success).toBe(false);
  });

  it("a cancellation needs a reason up to 500", () => {
    expect(cancelReasonSchema.safeParse("  ").success).toBe(false);
    expect(cancelReasonSchema.safeParse("x".repeat(501)).success).toBe(false);
    expect(cancelReasonSchema.parse(" נרשם בטעות ")).toBe("נרשם בטעות");
  });

  it("who records: owners, admins and managers, or a member with the key (app.can_record_documents)", () => {
    for (const role of ["owner", "admin", "manager"] as const) expect(canRecordDocuments(role, [])).toBe(true);
    expect(canRecordDocuments("member", [])).toBe(false);
    expect(canRecordDocuments("member", ["documents"])).toBe(true);
    expect(canRecordDocuments("viewer", ["documents"])).toBe(false);
    expect(canRecordDocuments(null, ["documents"])).toBe(false);
  });
});
