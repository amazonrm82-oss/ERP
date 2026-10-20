import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PAYMENT_INSTALLMENTS_MAX, PAYMENT_METHODS, PAYMENT_STATUSES, paymentSchema, receivedTotal, statusChoices } from "@/features/payments/schema";
import { canRecordPayments } from "@/features/permissions/keys";

// PAY-01, PAY-05, PAY-06: the form's rules mirror public.payments (migration payments).

const dir = path.join(process.cwd(), "supabase/migrations");
const migration = readFileSync(path.join(dir, readdirSync(dir).find((f) => f.endsWith("_payments.sql"))!), "utf8");
const listIn = (column: string) => {
  const listed = new RegExp(`${column}\\s+text not null(?: default '[a-z]+')? check \\(${column} in \\(([^)]*)\\)\\)`).exec(migration)?.[1] ?? "";
  return [...listed.matchAll(/'([^']+)'/g)].map((m) => m[1]);
};

describe("payments (PAY-01)", () => {
  it("the closed lists of methods and statuses equal the table's checks", () => {
    expect(listIn("method")).toEqual([...PAYMENT_METHODS]);
    expect(listIn("status")).toEqual([...PAYMENT_STATUSES]);
    expect(migration).toContain(`installments between 1 and ${PAYMENT_INSTALLMENTS_MAX}`);
  });

  it("reads the form: an amount in shekels, a date, a method, the instalments of a credit payment only", () => {
    expect(paymentSchema.parse({ amount: "1,170.50", paid_on: "2026-10-20", method: "credit", installments: "", reference: " A-1 ", note: "" })).toEqual({
      amount: 117050,
      paid_on: "2026-10-20",
      method: "credit",
      installments: 1,
      reference: "A-1",
      note: null,
    });
    expect(paymentSchema.parse({ amount: "100", paid_on: "2026-10-20", method: "credit", installments: "12", reference: "", note: "" }).installments).toBe(12);
    // a number left in the field of another method is dropped
    expect(paymentSchema.parse({ amount: "100", paid_on: "2026-10-20", method: "cash", installments: "3", reference: "", note: "" }).installments).toBeNull();
    for (const bad of [
      { amount: "0" },
      { amount: "" },
      { amount: "-5" },
      { paid_on: "2026-13-01" },
      { method: "barter" },
      { method: "credit", installments: "37" },
      { method: "credit", installments: "0" },
      { method: "credit", installments: "2.5" },
      { reference: "x".repeat(101) },
    ]) {
      expect(
        paymentSchema.safeParse({ amount: "100", paid_on: "2026-10-20", method: "transfer", installments: "", reference: "", note: "", ...bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it("PAY-06: who records, and which status moves a recorder sees", () => {
    for (const role of ["owner", "admin", "manager"] as const) expect(canRecordPayments(role, []), role).toBe(true);
    expect(canRecordPayments("member", [])).toBe(false);
    expect(canRecordPayments("member", ["record_payments"])).toBe(true);
    expect(canRecordPayments("viewer", ["record_payments"])).toBe(false);
    expect(canRecordPayments(null, ["record_payments"])).toBe(false);
    expect(statusChoices("recorded", false)).toEqual(["confirmed", "failed"]);
    expect(statusChoices("recorded", true)).toEqual(["confirmed", "failed", "refunded"]);
    expect(statusChoices("refunded", false)).toEqual([]);
    expect(statusChoices("refunded", true)).toEqual(["recorded", "confirmed", "failed"]);
    // a cancelled payment moves nowhere, and cancelling is its own window with a reason
    expect(statusChoices("cancelled", true)).toEqual([]);
    expect(statusChoices("confirmed", true)).not.toContain("cancelled");
  });

  it("the received total counts recorded and confirmed payments only (never failed, refunded or cancelled)", () => {
    expect(
      receivedTotal([
        { amountAgorot: 100, status: "recorded" },
        { amountAgorot: 200, status: "confirmed" },
        { amountAgorot: 400, status: "failed" },
        { amountAgorot: 800, status: "refunded" },
        { amountAgorot: 1600, status: "cancelled" },
      ]),
    ).toBe(300);
  });
});
