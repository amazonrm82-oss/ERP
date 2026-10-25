import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { addMonths, chequePaymentStatus, chequeSchema, chequeSeries, chequeStatusChoices, CHEQUE_STATUSES, ISRAELI_BANKS, next30DaysTotal } from "@/features/payments/cheques";

// PAY-04: the bank list and the status rule are one rule in two places (migration cheques); the series and the 30-day total.
const dir = path.join(process.cwd(), "supabase/migrations");
const migration = readFileSync(path.join(dir, readdirSync(dir).find((f) => f.endsWith("_cheques.sql"))!), "utf8");

describe("cheques (PAY-04)", () => {
  it("app.cheque_bank_codes() equals ISRAELI_BANKS", () => {
    const fn = migration.slice(migration.indexOf("function app.cheque_bank_codes"));
    const codes = [...fn.slice(0, fn.indexOf("$$;", fn.indexOf("$$") + 2)).matchAll(/'(\d{2})'/g)].map((m) => m[1]);
    expect(codes).toEqual(ISRAELI_BANKS.map((b) => b.code));
  });

  it("app.cheque_payment_status() equals chequePaymentStatus()", () => {
    const fn = migration.slice(migration.indexOf("function app.cheque_payment_status"));
    const pairs = Object.fromEntries([...fn.slice(0, fn.indexOf("$$;", fn.indexOf("$$") + 2)).matchAll(/when '([a-z_]+)' then '([a-z]+)'/g)].map((m) => [m[1], m[2]]));
    expect(pairs).toEqual(Object.fromEntries(CHEQUE_STATUSES.map((s) => [s, chequePaymentStatus(s)])));
  });

  it("only owners and admins move a cheque out of bounced", () => {
    expect(chequeStatusChoices("bounced", false)).toEqual([]);
    expect(chequeStatusChoices("bounced", true)).toEqual(["in_hand", "deposited", "cleared"]);
    expect(chequeStatusChoices("in_hand", false)).toEqual(["deposited", "cleared", "bounced"]);
  });

  it("reads a cheque: a listed bank and a 3-digit branch, or another bank by name", () => {
    const base = { cheque_number: "001234", cheque_bank: "10", cheque_bank_name: "", cheque_branch: "123", cheque_due_date: "2026-11-01", cheque_status: "in_hand" };
    expect(chequeSchema.parse(base)).toMatchObject({ cheque_number: "001234", cheque_bank: "10", cheque_bank_name: null, cheque_branch: "123" });
    expect(chequeSchema.safeParse({ ...base, cheque_branch: "12" }).success).toBe(false);
    expect(chequeSchema.safeParse({ ...base, cheque_bank: "99" }).success).toBe(false);
    expect(chequeSchema.safeParse({ ...base, cheque_number: "12a" }).success).toBe(false);
    expect(chequeSchema.safeParse({ ...base, cheque_bank: "other" }).success).toBe(false);
    expect(chequeSchema.parse({ ...base, cheque_bank: "other", cheque_bank_name: "Chase", cheque_branch: "" })).toMatchObject({ cheque_bank_name: "Chase", cheque_branch: null });
  });

  it("a series counts the numbers up (keeping leading zeros) and the dates by month from the first, or by days", () => {
    expect(chequeSeries({ number: "0098", dueDate: "2026-01-31" }, 3, { kind: "month" })).toEqual([
      { number: "0098", dueDate: "2026-01-31" },
      { number: "0099", dueDate: "2026-02-28" },
      { number: "0100", dueDate: "2026-03-31" },
    ]);
    expect(chequeSeries({ number: "5", dueDate: "2026-12-20" }, 2, { kind: "days", days: 15 })).toEqual([
      { number: "5", dueDate: "2026-12-20" },
      { number: "6", dueDate: "2027-01-04" },
    ]);
    expect(chequeSeries({ number: "99999999999999999999", dueDate: "2026-01-01" }, 2, { kind: "month" })).toBeNull();
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
  });

  it("the 30-day total counts today through 30 days ahead", () => {
    const cheques = [
      { dueDate: "2026-10-24", amountAgorot: 1 },
      { dueDate: "2026-10-25", amountAgorot: 10 },
      { dueDate: "2026-11-24", amountAgorot: 100 },
      { dueDate: "2026-11-25", amountAgorot: 1000 },
    ];
    expect(next30DaysTotal(cheques, "2026-10-25")).toBe(110);
  });
});
