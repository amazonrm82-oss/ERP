import { describe, expect, it } from "vitest";

import { LEDGER_PARTIAL_TEXT, ledgerPeriod, ledgerView, lineMuted, lineNote, lineTitle, parseLedger, yearBefore, type LedgerLine } from "@/features/balances/ledger";

const line = (over: Partial<LedgerLine & { balance: number }>): LedgerLine & { balance: number } => ({
  kind: "document",
  id: "x",
  date: "2026-03-01",
  type: "tax_invoice",
  label: "101",
  status: "active",
  invoice_number: null,
  proforma_number: null,
  amount: 1000,
  debit: 1000,
  credit: 0,
  balance: 1000,
  ...over,
});

describe("customer ledger (BAL-01)", () => {
  it("reads the database's answer and refuses a shape it does not know", () => {
    expect(parseLedger({ allowed: false })).toEqual({ allowed: false });
    const ok = parseLedger({
      allowed: true,
      partial: false,
      from: "2026-01-01",
      to: "2026-12-31",
      opening: 0,
      shown_opening: 0,
      truncated: false,
      debit: 1000,
      credit: 0,
      closing: 1000,
      open_debt: 1000,
      credit_balance: 0,
      lines: [line({})],
    });
    expect(ok.allowed).toBe(true);
    expect(ledgerView(ok)).toBe("full");
    expect(() => parseLedger({ allowed: true })).toThrow();
    // a full answer must carry every balance, and each line its running balance
    const { balance: _b, ...noBalance } = line({});
    void _b;
    expect(() => parseLedger({ ...ok, lines: [noBalance] })).toThrow();
    const { open_debt: _d, ...noDebt } = ok as Record<string, unknown>;
    void _d;
    expect(() => parseLedger(noDebt)).toThrow();
  });

  it("owner's answer (3) ב: a partial answer is the lines only, shown with the notice and no balance", () => {
    const { balance: _b, ...seen } = line({});
    void _b;
    const partial = parseLedger({ allowed: true, partial: true, from: "2026-01-01", to: "2026-12-31", truncated: false, lines: [seen] });
    expect(ledgerView(partial)).toBe("partial");
    expect(partial).not.toHaveProperty("closing");
    expect(partial).not.toHaveProperty("open_debt");
    if (partial.allowed) expect(partial.lines[0]).not.toHaveProperty("balance");
    // balances sent along with partial are dropped, never shown
    const extra = parseLedger({ allowed: true, partial: true, from: "2026-01-01", to: "2026-12-31", truncated: false, lines: [line({})], closing: 5 });
    expect(extra).not.toHaveProperty("closing");
    if (extra.allowed) expect(extra.lines[0]).not.toHaveProperty("balance");
    expect(ledgerView(parseLedger({ allowed: false }))).toBe("hidden");
    expect(LEDGER_PARTIAL_TEXT).toBe("חלק מהשורות מוסתרות");
    expect(() => parseLedger({ allowed: true, partial: true, from: "2026-01-01", to: "2026-12-31", lines: [] })).toThrow();
  });

  it("the default period is the last 12 months; a typed one wins, a reversed one is swapped", () => {
    expect(ledgerPeriod("2026-10-25")).toEqual({ from: "2025-10-25", to: "2026-10-25" });
    expect(ledgerPeriod("2026-10-25", "2026-01-01", "2026-03-31")).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(ledgerPeriod("2026-10-25", "2026-05-01", "2026-04-01")).toEqual({ from: "2026-04-01", to: "2026-05-01" });
    expect(ledgerPeriod("2026-10-25", "not a date", null)).toEqual({ from: "2025-10-25", to: "2026-10-25" });
    expect(yearBefore("2028-02-29")).toBe("2027-02-28");
  });

  it("words each line and says why a line moves nothing", () => {
    expect(lineTitle(line({}))).toBe("חשבונית מס 101");
    expect(lineTitle(line({ kind: "payment", type: "cheque", label: null }))).toBe("תשלום · צ'ק");
    expect(lineNote(line({ status: "cancelled", debit: 0 }))).toBe("בוטל, לא נספר");
    expect(lineNote(line({ type: "proforma", invoice_number: "205" }))).toBe("הועבר לחשבונית מס 205");
    expect(lineNote(line({ type: "tax_invoice", proforma_number: "17", debit: 0 }))).toBe("במקום חשבון עסקה 17: נספר רק ההפרש");
    expect(lineNote(line({ type: "tax_invoice" }))).toBeNull();
    expect(lineNote(line({ type: "receipt", debit: 0 }))).toContain("בלי סכום");
    expect(lineNote(line({ kind: "payment", type: "transfer", status: "failed", debit: 0 }))).toBe("נכשל, לא נספר");
    expect(lineNote(line({ kind: "payment", type: "transfer", status: "confirmed", debit: 0, credit: 1000 }))).toBeNull();
    expect(lineMuted(line({ debit: 0 }))).toBe(true);
    expect(lineMuted(line({}))).toBe(false);
  });
});
