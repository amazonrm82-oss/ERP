import { describe, expect, it } from "vitest";

import { choiceKeys, choiceTotals, initialChoice, linesWithChoice } from "@/features/quotes/optional-choice";
import type { QuoteLine } from "@/features/quotes/queries";

// QUO-08: the customer's choice of optional lines on the quote's page (the database works the same total out,
// app.quote_counted_totals; tests/db/275 checks the server side)
const line = (place: number, over: Partial<QuoteLine>): QuoteLine =>
  ({
    id: `line-${place}`,
    position: place,
    kind: "item",
    productId: null,
    name: `שורה ${place}`,
    description: null,
    unitName: null,
    quantity: 1,
    unitPriceAgorot: 0,
    discountBp: null,
    discountAgorot: null,
    vatExempt: false,
    billing: "one_time",
    isOptional: false,
    optionalSelected: false,
    source: "manual",
    priceListId: null,
    priceListName: null,
    totalAgorot: 0,
    ...over,
  }) as QuoteLine;

const lines = [
  line(1, { kind: "group", name: "עבודות" }),
  line(2, { unitPriceAgorot: 50000, totalAgorot: 50000 }),
  line(3, { unitPriceAgorot: 10000, totalAgorot: 10000, isOptional: true }),
  line(4, { unitPriceAgorot: 20000, totalAgorot: 20000, isOptional: true, optionalSelected: true }),
];
const quote = { vatRateBp: 1800, pricesIncludeVat: false, discountBp: null, discountAgorot: null };

describe("optional lines on the customer's page (QUO-08)", () => {
  it("starts with every optional line unticked, whatever the rep preselected (owner: ברירת מחדל לא מסומנות)", () => {
    expect(initialChoice(lines)).toEqual([]);
    // the starting total is the quote without its optional lines, not the sent total (which counts the preselected one)
    const start = choiceTotals(quote, lines, initialChoice(lines));
    expect(start.ok && start.totals.netTotalAgorot).toBe(50000);
  });

  it("works the total of the choice out at the quote's rate", () => {
    const sent = choiceTotals(quote, lines, ["line-4"]);
    expect(sent.ok && sent.totals.netTotalAgorot).toBe(70000);
    const picked = choiceTotals(quote, lines, ["line-3"]);
    expect(picked.ok && picked.totals.netTotalAgorot).toBe(60000);
    expect(picked.ok && picked.totals.totalAgorot).toBe(70800);
    const none = choiceTotals(quote, lines, []);
    expect(none.ok && none.totals.totalAgorot).toBe(59000);
  });

  it("a fixed document discount above the chosen lines cannot be accepted", () => {
    expect(choiceTotals({ ...quote, discountAgorot: 55000 }, lines, []).ok).toBe(false);
  });

  it("names only optional items, by their place, sorted", () => {
    expect(choiceKeys(lines, ["line-4", "line-3", "line-2", "line-1", "line-9"])).toEqual([3, 4]);
    expect(choiceKeys(lines, [])).toEqual([]);
  });

  it("puts the choice in place of the preselection and leaves other lines alone", () => {
    expect(linesWithChoice(lines, ["line-3"]).map((l) => l.optionalSelected)).toEqual([false, false, true, false]);
  });
});

describe("what the page posts (QUO-08)", async () => {
  const { decisionBodySchema, questionBodySchema, QUESTION_MESSAGES, isQuestionStatus } = await import("@/features/quotes/decision");
  const accept = { decision: "accepted", fingerprint: "a".repeat(64), signerName: "נועה לוי", idNumber: null, signatureKind: "typed", signatureImage: null, agreed: true };

  it("an acceptance may carry the ticked places and the total shown", () => {
    expect(decisionBodySchema.safeParse({ ...accept, optionalKeys: [3], acceptedTotalAgorot: 70800 }).success).toBe(true);
    expect(decisionBodySchema.safeParse(accept).success).toBe(true);
    expect(decisionBodySchema.safeParse({ ...accept, optionalKeys: [0], acceptedTotalAgorot: 1 }).success).toBe(false);
    expect(decisionBodySchema.safeParse({ ...accept, optionalKeys: [1.5], acceptedTotalAgorot: 1 }).success).toBe(false);
    expect(decisionBodySchema.safeParse({ ...accept, optionalKeys: [], acceptedTotalAgorot: -1 }).success).toBe(false);
  });

  it("a question is 1..500 characters after trimming", () => {
    expect(questionBodySchema.safeParse({ text: "  שאלה  " }).data).toEqual({ text: "שאלה" });
    expect(questionBodySchema.safeParse({ text: "   " }).success).toBe(false);
    expect(questionBodySchema.safeParse({ text: "א".repeat(501) }).success).toBe(false);
    expect(isQuestionStatus("sent")).toBe(true);
    expect(isQuestionStatus("other")).toBe(false);
    expect(Object.keys(QUESTION_MESSAGES).sort()).toEqual(["closed", "invalid", "rate_limited", "sent"]);
  });
});
