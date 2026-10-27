import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  cancelReasonSchema,
  DOCUMENT_TYPE_LABELS,
  DOCUMENT_TYPES,
  documentSchema,
  documentTitle,
  parseSignedAgorot,
  recordableTypes,
  takesDueDate,
} from "@/features/documents/schema";
import { canRecordDocuments } from "@/features/permissions/keys";

// DOC-01: the form's rules mirror public.accounting_documents (migration accounting_documents).

const dir = path.join(process.cwd(), "supabase/migrations");
// GAP-12: the type list is last set by the opening balance migration
const migration = readFileSync(path.join(dir, readdirSync(dir).find((f) => f.endsWith("_opening_balance.sql"))!), "utf8");

describe("accounting documents (DOC-01)", () => {
  it("the closed list of types equals the table's check, with the owner's Hebrew names", () => {
    const listed = /accounting_documents_doc_type_check\s+check \(doc_type in \(([^)]*)\)\)/.exec(migration)?.[1] ?? "";
    expect([...listed.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual([...DOCUMENT_TYPES]);
    expect(DOCUMENT_TYPE_LABELS).toEqual({
      tax_invoice: "חשבונית מס",
      tax_invoice_receipt: "חשבונית מס/קבלה",
      receipt: "קבלה",
      credit_invoice: "חשבונית זיכוי",
      proforma: "חשבונית עסקה",
      opening_balance: "יתרת פתיחה",
    });
  });

  it("reads the form: a type from the list, a number up to 40, a date and an amount in shekels", () => {
    expect(documentSchema.parse({ doc_type: "receipt", number: " 1001 ", doc_date: "2026-10-20", amount: "1,170.50" })).toEqual({
      doc_type: "receipt",
      number: "1001",
      doc_date: "2026-10-20",
      amount: 117050,
      // PAY-02 answer 7: no due date typed = from the customer's terms
      due_date: null,
    });
    expect(documentSchema.safeParse({ doc_type: "bill", number: "1", doc_date: "2026-10-20", amount: "1" }).success).toBe(false);
    expect(documentSchema.safeParse({ doc_type: "receipt", number: "x".repeat(41), doc_date: "2026-10-20", amount: "1" }).success).toBe(false);
    expect(documentSchema.safeParse({ doc_type: "receipt", number: "", doc_date: "2026-10-20", amount: "1" }).success).toBe(false);
    expect(documentSchema.safeParse({ doc_type: "receipt", number: "1", doc_date: "2026-02-30", amount: "1" }).success).toBe(false);
    expect(documentSchema.safeParse({ doc_type: "receipt", number: "1", doc_date: "2026-10-20", amount: "" }).success).toBe(false);
    expect(documentSchema.safeParse({ doc_type: "receipt", number: "1", doc_date: "2026-10-20", amount: "-5" }).success).toBe(false);
  });

  it("GAP-12: an opening balance has no number, a signed amount that is not 0, and a due date only as a debt", () => {
    expect(documentSchema.parse({ doc_type: "opening_balance", number: "7", doc_date: "2026-01-01", amount: "-1,250.50" })).toEqual({
      doc_type: "opening_balance",
      number: null,
      doc_date: "2026-01-01",
      amount: -125050,
      due_date: null,
    });
    expect(documentSchema.parse({ doc_type: "opening_balance", number: "", doc_date: "2026-01-01", amount: "800", due_date: "2026-02-01" }).due_date).toBe(
      "2026-02-01",
    );
    expect(documentSchema.safeParse({ doc_type: "opening_balance", number: "", doc_date: "2026-01-01", amount: "0" }).success).toBe(false);
    expect(documentSchema.safeParse({ doc_type: "opening_balance", number: "", doc_date: "2026-01-01", amount: "-5", due_date: "2026-02-01" }).success).toBe(false);
    // a number is still required on every other type, and only an opening balance is negative
    expect(documentSchema.safeParse({ doc_type: "tax_invoice", number: "", doc_date: "2026-01-01", amount: "5" }).success).toBe(false);
    expect(documentSchema.safeParse({ doc_type: "credit_invoice", number: "1", doc_date: "2026-01-01", amount: "-5" }).success).toBe(false);
    expect(parseSignedAgorot("\u2212300")).toBe(-30000);
    expect(parseSignedAgorot("--3")).toBeNull();
    expect(takesDueDate("opening_balance", 100)).toBe(true);
    expect(takesDueDate("opening_balance", -100)).toBe(false);
    expect(takesDueDate("receipt")).toBe(false);
    expect(recordableTypes(false)).not.toContain("opening_balance");
    expect(recordableTypes(true)).toContain("opening_balance");
    expect(documentTitle({ docType: "tax_invoice", number: "1001", docDate: "2026-01-01" })).toBe("חשבונית מס 1001");
    expect(documentTitle({ docType: "opening_balance", number: null, docDate: "2026-01-01" })).toMatch(/^יתרת פתיחה מתאריך .*2026$/);
  });

  it("GAP-12: the table's amount and number rules for an opening balance", () => {
    expect(migration).toMatch(/doc_type = 'opening_balance' and amount_agorot between -1000000000000 and 1000000000000 and amount_agorot <> 0/);
    expect(migration).toMatch(/check \(\(doc_type = 'opening_balance'\) = \(number is null\)\)/);
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
