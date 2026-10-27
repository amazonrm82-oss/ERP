import { describe, expect, it } from "vitest";

import { documentSchema } from "@/features/documents/schema";
import { defaultSplit, documentStateChip, parseCandidates, parseMoneyState, takesPayments } from "@/features/allocations/state";

// PAY-02: the screen reads the database's answer (public.money_allocation_state / money_allocation_candidates) and labels it.
describe("payment allocations on screen (PAY-02)", () => {
  it("reads the state by id, amounts as numbers (bigint arrives as a string or a number)", () => {
    const state = parseMoneyState({
      documents: [{ id: "d1", paid: "4000", balance: 6000, state: "partial", invoice_number: null }],
      payments: [{ id: "p1", allocated: 4000, credit: "1000" }],
    });
    // GAP-12: `credit` (a negative opening balance's credit left) reads as 0 when the answer has none
    expect(state.documents.get("d1")).toEqual({ paid: 4000, balance: 6000, state: "partial", invoiceNumber: null, credit: 0 });
    expect(state.payments.get("p1")).toEqual({ allocated: 4000, credit: 1000 });
    expect(() => parseMoneyState({ documents: [{ id: "d1", paid: 0, balance: 0, state: "owed", invoice_number: null }], payments: [] })).toThrow();
  });

  it("names each state; a receipt, a credit invoice and a cancelled document show none", () => {
    const chip = (state: Parameters<typeof documentStateChip>[0]["state"], invoiceNumber: string | null = null) =>
      documentStateChip({ paid: 0, balance: 0, state, invoiceNumber })?.label ?? null;
    expect(chip("unpaid")).toBe("לא שולם");
    expect(chip("partial")).toBe("שולם חלקית");
    expect(chip("paid")).toBe("שולם");
    expect(chip("paid_on_issue")).toBe("שולם");
    expect(chip("transferred", "INV-7")).toBe("הועבר לחשבונית INV-7");
    expect(chip("none")).toBeNull();
  });

  it("only an unpaid or partly paid document with a balance takes payments", () => {
    expect(takesPayments({ paid: 0, balance: 100, state: "unpaid", invoiceNumber: null })).toBe(true);
    expect(takesPayments({ paid: 50, balance: 50, state: "partial", invoiceNumber: null })).toBe(true);
    expect(takesPayments({ paid: 100, balance: 0, state: "paid", invoiceNumber: null })).toBe(false);
    expect(takesPayments({ paid: 0, balance: 0, state: "transferred", invoiceNumber: "1" })).toBe(false);
    expect(takesPayments(undefined)).toBe(false);
  });

  it("offers the available amount in order, never more than a row can take", () => {
    expect(defaultSplit(1000, [400, 400, 400])).toEqual([400, 400, 200]);
    expect(defaultSplit(300, [1000])).toEqual([300]);
    expect(defaultSplit(0, [100, 100])).toEqual([0, 0]);
    expect(defaultSplit(500, [-1, 600])).toEqual([0, 500]);
  });

  it("reads the window's candidates", () => {
    const c = parseCandidates({
      documents: [{ id: "d", doc_type: "tax_invoice", number: "1", doc_date: "2026-10-01", amount: 1000, balance: "900" }],
      payments: [],
      proformas: [{ id: "p", number: "2", doc_date: "2026-10-02", amount: 500 }],
    });
    expect(c.documents[0].balance).toBe(900);
    expect(c.proformas).toHaveLength(1);
  });

  it("a due date is optional, only on a tax invoice or a proforma, never before the document's date (answer 7)", () => {
    const base = { doc_type: "tax_invoice", number: "1", doc_date: "2026-10-10", amount: "100" };
    expect(documentSchema.parse({ ...base, due_date: "" }).due_date).toBeNull();
    expect(documentSchema.parse({ ...base, due_date: "2026-11-01" }).due_date).toBe("2026-11-01");
    expect(documentSchema.safeParse({ ...base, due_date: "2026-10-09" }).success).toBe(false);
    expect(documentSchema.safeParse({ ...base, doc_type: "receipt", due_date: "2026-11-01" }).success).toBe(false);
    expect(documentSchema.parse({ ...base, doc_type: "receipt", due_date: "" }).due_date).toBeNull();
  });
});
