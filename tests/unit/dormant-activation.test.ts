import { describe, expect, it } from "vitest";

import {
  backfillMessage,
  dormantCheckboxLabel,
  dormantQuestion,
  parseBackfillAnswer,
  shouldAskDormant,
  sumBackfill,
} from "@/features/automations/dormant-activation";

// RET-01, owner's answer (64) ג: the question after switching a dormant-customer rule on, and the answer's wording
describe("asking about customers already dormant", () => {
  const base = { asked: true, isActive: true, triggerType: "customer_dormant", dormantFrom: "2026-11-02", today: "2026-11-02", count: 3 };

  it("asks only right after switching on, for an active dormant rule with someone to run on", () => {
    expect(shouldAskDormant(base)).toBe(true);
    expect(shouldAskDormant({ ...base, asked: false })).toBe(false);
    expect(shouldAskDormant({ ...base, isActive: false })).toBe(false);
    expect(shouldAskDormant({ ...base, triggerType: "created" })).toBe(false);
    expect(shouldAskDormant({ ...base, dormantFrom: "2026-11-01" })).toBe(false);
    expect(shouldAskDormant({ ...base, dormantFrom: null })).toBe(false);
    expect(shouldAskDormant({ ...base, count: 0 })).toBe(false);
    expect(shouldAskDormant({ ...base, count: null })).toBe(false);
  });

  it("names the number in the owner's words", () => {
    expect(dormantQuestion(12)).toBe("יש כבר 12 לקוחות רדומים. להריץ את הכלל גם עליהם?");
    expect(dormantQuestion(1)).toBe("יש כבר לקוח רדום אחד. להריץ את הכלל גם עליו?");
    expect(dormantCheckboxLabel(12)).toContain("12");
  });

  it("reads the database's answers and sums one click's calls", () => {
    expect(parseBackfillAnswer({ ok: true, ran: 2, skipped: 0, more: false, quota: false })).toEqual({ ok: true, ran: 2, skipped: 0, more: false, quota: false });
    expect(parseBackfillAnswer({ ok: false, reason: "done" })).toEqual({ ok: false, reason: "done" });
    expect(parseBackfillAnswer(null)).toBeNull();
    expect(parseBackfillAnswer({ ok: true })).toBeNull();
    const total = sumBackfill([
      { ok: true, ran: 1000, skipped: 0, more: true, quota: false },
      { ok: true, ran: 20, skipped: 1, more: false, quota: false },
    ]);
    expect(total).toEqual({ ran: 1020, skipped: 1, more: false, quota: false, refused: null });
    expect(backfillMessage(total)).toBe("הכלל הורץ על 1020 לקוחות רדומים. 1 דולגו.");
  });

  it("says when it already ran, when the quota stopped it and when more are left", () => {
    expect(backfillMessage(sumBackfill([{ ok: false, reason: "done" }]))).toBe("הכלל כבר הורץ על הלקוחות הרדומים הקיימים.");
    expect(backfillMessage(sumBackfill([{ ok: true, ran: 1, skipped: 1, more: false, quota: true }]))).toContain("מכסת ההרצות");
    expect(backfillMessage(sumBackfill([{ ok: true, ran: 200, skipped: 0, more: true, quota: false }]))).toContain("להמשיך");
    expect(backfillMessage(sumBackfill([{ ok: true, ran: 0, skipped: 0, more: false, quota: false }]))).toBe("אין עוד לקוחות רדומים להריץ עליהם את הכלל.");
  });
});
