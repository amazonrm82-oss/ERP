import { describe, expect, it } from "vitest";

import { documentListFilters, documentListHref, needsPayStateRead } from "@/features/documents/list";
import { DOCUMENT_PAY_FILTERS, documentPayState } from "@/features/documents/pay-state";
import { documentExtraCells, documentExtraHeader } from "@/features/documents/export-table";

// DOC-03: the documents list's payment state, customer filter and export columns (the SQL mirror and the summary line are
// tested in tests/db/270-documents-pay-state.test.ts).

const ORG = "99999999-9999-4999-8999-999999999999";
const CONTACT = "11111111-1111-4111-8111-111111111111";

describe("payment state", () => {
  it("cancelled, then paid, then overdue, then partial / open; transferred and none", () => {
    expect(documentPayState(true, "paid", null, "2026-01-10")).toBe("cancelled");
    expect(documentPayState(false, "paid_on_issue", null, "2026-01-10")).toBe("paid");
    expect(documentPayState(false, "paid", "2026-01-01", "2026-01-10")).toBe("paid");
    expect(documentPayState(false, "partial", "2026-01-09", "2026-01-10")).toBe("overdue");
    expect(documentPayState(false, "unpaid", "2026-01-10", "2026-01-10")).toBe("open");
    expect(documentPayState(false, "partial", null, "2026-01-10")).toBe("partial");
    expect(documentPayState(false, "transferred", "2026-01-01", "2026-01-10")).toBe("transferred");
    expect(documentPayState(false, "none", null, "2026-01-10")).toBe("none");
    expect(documentPayState(false, null, null, "2026-01-10")).toBe("none");
  });
  it("offers the spec's five as filters", () => {
    expect([...DOCUMENT_PAY_FILTERS]).toEqual(["open", "partial", "paid", "overdue", "cancelled"]);
  });
});

describe("the list's address", () => {
  it("reads a payment state and one customer, and writes them back", () => {
    const filters = documentListFilters({ pay: "overdue", contact: CONTACT, contact__label: "דנה", company: CONTACT });
    expect(filters.pay).toBe("overdue");
    expect(filters.customer).toEqual({ kind: "contact", id: CONTACT, label: "דנה" });
    expect(needsPayStateRead(filters)).toBe(true);
    expect(documentListHref(ORG, filters)).toContain(`pay=overdue&contact=${CONTACT}&contact__label=`);
  });
  it("drops what is not valid", () => {
    const filters = documentListFilters({ pay: "late", contact: "x", company: "y" });
    expect(filters.pay).toBeNull();
    expect(filters.customer).toBeNull();
    expect(needsPayStateRead(filters)).toBe(false);
  });
});

describe("the export's extra columns", () => {
  it("the due date always; the payment state and balance with the payments key", () => {
    expect(documentExtraHeader(false)).toEqual(["מועד תשלום"]);
    expect(documentExtraCells({ dueDate: "2026-01-10" }, null, false)).toEqual(["2026-01-10"]);
    expect(documentExtraHeader(true)).toHaveLength(3);
    expect(documentExtraCells({ dueDate: null }, { payState: "partial", balance: 12_345 }, true)).toEqual(["", "שולם חלקית", "123.45"]);
    expect(documentExtraCells({ dueDate: null }, { payState: "paid", balance: null }, true)).toEqual(["", "שולם", ""]);
  });
});
