import { describe, expect, it } from "vitest";

import { documentLineTotal, documentOrigin, isAllocationNumber, parseDocumentDetails, parseDocumentLines, takesAllocationNumber } from "@/features/documents/details";

// DOC-02: the details and lines of a recorded document, as the form sends them (mirrors the constraints of migration
// document_details; the database judges again, tests/db/269-document-details.test.ts).

const blank = { allocation_number: "", net: "", vat: "", vat_rate: "", quote_id: "", original_document_id: "" };

describe("document line total", () => {
  it("rounds quantity x unit price half up, then takes off the discount", () => {
    expect(documentLineTotal({ quantity: 2.5, unitPriceAgorot: 3333, discountAgorot: 100 })).toBe(8233);
    expect(documentLineTotal({ quantity: 0.001, unitPriceAgorot: 500, discountAgorot: 0 })).toBe(1);
    expect(documentLineTotal({ quantity: 0.001, unitPriceAgorot: 499, discountAgorot: 0 })).toBe(0);
    expect(documentLineTotal({ quantity: 1_000_000, unitPriceAgorot: 1_000_000_000_000, discountAgorot: 0 })).toBe(1e18);
  });
});

describe("document lines from the form", () => {
  const row = (fields: Partial<{ description: string; quantity: string; unitPrice: string; discount: string; vatExempt: boolean }>) => ({
    description: "",
    quantity: "1",
    unitPrice: "",
    discount: "",
    vatExempt: false,
    ...fields,
  });
  it("reads typed rows and leaves out empty ones", () => {
    const parsed = parseDocumentLines(JSON.stringify([row({ description: " עבודה ", quantity: "2", unitPrice: "1,250.50", discount: "10" }), row({})]));
    expect(parsed).toEqual({ ok: true, lines: [{ description: "עבודה", quantity: 2, unitPriceAgorot: 125050, discountAgorot: 1000, vatExempt: false }] });
    expect(parseDocumentLines("")).toEqual({ ok: true, lines: [] });
  });
  it("names the row of a problem", () => {
    expect(parseDocumentLines(JSON.stringify([row({ unitPrice: "5" })]))).toEqual({ ok: false, message: "שורה 1: יש לכתוב תיאור." });
    expect(parseDocumentLines(JSON.stringify([row({ description: "x", quantity: "0" })]))).toMatchObject({ ok: false });
    expect(parseDocumentLines(JSON.stringify([row({ description: "x", quantity: "1.0005" })]))).toMatchObject({ ok: false });
    expect(parseDocumentLines(JSON.stringify([row({ description: "x", unitPrice: "1", discount: "2" })]))).toEqual({ ok: false, message: "שורה 1: ההנחה גדולה מסכום השורה." });
    expect(parseDocumentLines("{")).toMatchObject({ ok: false });
    const many = Array.from({ length: 201 }, (_, i) => row({ description: `שורה ${i}` }));
    expect(parseDocumentLines(JSON.stringify(many))).toEqual({ ok: false, message: "במסמך יש עד 200 שורות." });
  });
});

describe("document details from the form", () => {
  it("allocation number: digits, tax invoices only", () => {
    expect(takesAllocationNumber("tax_invoice")).toBe(true);
    expect(takesAllocationNumber("receipt")).toBe(false);
    expect(isAllocationNumber("123456789")).toBe(true);
    expect(isAllocationNumber("12-3")).toBe(false);
    expect(parseDocumentDetails({ ...blank, allocation_number: "123" }, "receipt", 100)).toMatchObject({ ok: false, fieldErrors: { allocation_number: expect.any(String) } });
    expect(parseDocumentDetails({ ...blank, allocation_number: " 123 " }, "tax_invoice_receipt", 100)).toMatchObject({ ok: true, details: { allocationNumber: "123" } });
  });
  it("the VAT split adds up to the amount; the rate goes with it", () => {
    expect(parseDocumentDetails({ ...blank, net: "100", vat: "17", vat_rate: "17" }, "tax_invoice", 11700)).toEqual({
      ok: true,
      details: { allocationNumber: null, netAgorot: 10000, vatAgorot: 1700, vatRateBp: 1700, quoteId: null, originalDocumentId: null },
    });
    expect(parseDocumentDetails({ ...blank, net: "100", vat: "16" }, "tax_invoice", 11700)).toMatchObject({ ok: false, fieldErrors: { vat: expect.any(String) } });
    expect(parseDocumentDetails({ ...blank, net: "100" }, "tax_invoice", 10000)).toMatchObject({ ok: false, fieldErrors: { vat: expect.any(String) } });
    expect(parseDocumentDetails({ ...blank, vat_rate: "17" }, "tax_invoice", 10000)).toMatchObject({ ok: false, fieldErrors: { vat_rate: expect.any(String) } });
  });
  it("a credit invoice's original; ids that are not ids are dropped", () => {
    const id = "0b3c5c1e-1111-4222-8333-944455556666";
    expect(parseDocumentDetails({ ...blank, original_document_id: id }, "tax_invoice", 1)).toMatchObject({ ok: false });
    expect(parseDocumentDetails({ ...blank, original_document_id: id, quote_id: "x" }, "credit_invoice", 1)).toMatchObject({
      ok: true,
      details: { originalDocumentId: id, quoteId: null },
    });
  });
  it("names who issued a document", () => {
    expect(documentOrigin(null)).toBe("נרשם ידנית");
    expect(documentOrigin("icount")).toContain("icount");
  });
});
