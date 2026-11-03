import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { countedAmount, refundable, refundCancelSchema, refundedLine, refundedTotal, refundSchema } from "@/features/payments/refunds";
import { PAYMENT_METHODS } from "@/features/payments/schema";

// PAY-08: refunds of payments (migration payment_refunds)
describe("refunds (PAY-08)", () => {
  it("counts a payment less its active refunds, and only while recorded or confirmed (= public.payment_counted)", () => {
    const refunds = [
      { amountAgorot: 300, status: "active" as const },
      { amountAgorot: 200, status: "cancelled" as const },
      { amountAgorot: 100, status: "active" as const },
    ];
    expect(refundedTotal(refunds)).toBe(400);
    expect(countedAmount({ amountAgorot: 1000, status: "recorded" }, 400)).toBe(600);
    expect(countedAmount({ amountAgorot: 1000, status: "confirmed" }, 1000)).toBe(0);
    expect(countedAmount({ amountAgorot: 1000, status: "refunded" }, 1000)).toBe(0);
    expect(countedAmount({ amountAgorot: 1000, status: "failed" }, 0)).toBe(0);
    expect(refundable({ amountAgorot: 1000, status: "recorded" }, 400)).toBe(600);
    expect(refundable({ amountAgorot: 1000, status: "cancelled" }, 0)).toBe(0);
  });

  it("words a partial and a full refund", () => {
    expect(refundedLine({ amountAgorot: 1000, status: "recorded" }, 0)).toBeNull();
    expect(refundedLine({ amountAgorot: 1000, status: "recorded" }, 300)).toBe("הוחזר חלקית");
    expect(refundedLine({ amountAgorot: 1000, status: "refunded" }, 1000)).toBe("הוחזר במלואו");
  });

  it("checks the form: an amount in shekels, a date, a method from the payments' list, an optional credit invoice", () => {
    const ok = refundSchema.safeParse({ amount: "300", refunded_on: "2026-11-03", method: "transfer", reference: " ", note: "", credit_document_id: "" });
    expect(ok.success && ok.data).toEqual({ amount: 30000, refunded_on: "2026-11-03", method: "transfer", reference: null, note: null, credit_document_id: null });
    expect(refundSchema.safeParse({ amount: "0", refunded_on: "2026-11-03", method: "transfer", reference: "", note: "", credit_document_id: "" }).success).toBe(false);
    expect(refundSchema.safeParse({ amount: "10", refunded_on: "x", method: "transfer", reference: "", note: "", credit_document_id: "" }).success).toBe(false);
    expect(refundSchema.safeParse({ amount: "10", refunded_on: "2026-11-03", method: "gold", reference: "", note: "", credit_document_id: "" }).success).toBe(false);
    expect(refundSchema.safeParse({ amount: "10", refunded_on: "2026-11-03", method: "cash", reference: "", note: "", credit_document_id: "nope" }).success).toBe(false);
    expect(refundCancelSchema.safeParse({ reason: "  " }).success).toBe(false);
    expect(refundCancelSchema.safeParse({ reason: "טעות" }).success).toBe(true);
  });

  it("the methods are the database's closed list", () => {
    const dir = path.join(process.cwd(), "supabase/migrations");
    const file = readdirSync(dir).find((f) => f.endsWith("_payment_refunds.sql")) as string;
    const sql = readFileSync(path.join(dir, file), "utf8");
    const list = /method\s+text not null check \(method in \(([^)]*)\)\)/.exec(sql)?.[1];
    expect(list?.split(",").map((m) => m.trim().replace(/'/g, ""))).toEqual([...PAYMENT_METHODS]);
  });
});
