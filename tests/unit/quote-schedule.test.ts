import { describe, expect, it } from "vitest";

import { parsePercentBp, percentText, scheduleAmounts, scheduleRows, scheduleStepSchema, scheduleTotalNote } from "@/features/quotes/schedule";

// GAP-09: the payment schedule of a quote. scheduleAmounts mirrors app.quote_schedule(): cumulative shares, half up.

/** The SQL rule, written out: round(total * cum / 10000) - round(total * (cum - bp) / 10000), half away from zero. */
function sqlRule(total: number, percents: number[]): number[] {
  const round = (n: number, d: number) => Math.sign(n) * Math.floor((Math.abs(n) * 2 + d) / (2 * d));
  let cum = 0;
  return percents.map((bp) => {
    cum += bp;
    return round(total * cum, 10000) - round(total * (cum - bp), 10000);
  });
}

describe("a quote's payment schedule (GAP-09)", () => {
  it("the shares add up to the total exactly when the percents make 100%", () => {
    const cases: Array<[number, number[]]> = [
      [10001, [3333, 3333, 3334]],
      [23600, [3000, 7000]],
      [1, [5000, 5000]],
      [99999, [1, 9998, 1]],
      [123456789, [1250, 1250, 2500, 5000]],
      [0, [10000]],
    ];
    for (const [total, percents] of cases) {
      const amounts = scheduleAmounts(total, percents);
      expect(amounts.reduce((a, b) => a + b, 0), `${total}`).toBe(total);
      expect(amounts, `${total}`).toEqual(sqlRule(total, percents));
    }
  });

  it("an incomplete draft shows each step's share, and says what is missing", () => {
    expect(scheduleAmounts(10000, [3000])).toEqual([3000]);
    expect(scheduleTotalNote([{ percentBp: 3000 }])).toBe("סך האחוזים 30%. לפני שליחת ההצעה הלוח צריך להגיע בדיוק ל-100%.");
    expect(scheduleTotalNote([{ percentBp: 3000 }, { percentBp: 7000 }])).toBeNull();
    expect(scheduleTotalNote([])).toBeNull();
    // ORD-04: an order's schedule says when it must be complete
    expect(scheduleTotalNote([{ percentBp: 3000 }], "order")).toBe("סך האחוזים 30%. לפני אישור ההזמנה הלוח צריך להגיע בדיוק ל-100%.");
    const rows = scheduleRows(10001, [
      { id: "a", position: 0, name: "א", percentBp: 5000, dueDate: null, milestone: "x" },
      { id: "b", position: 1, name: "ב", percentBp: 5000, dueDate: "2027-01-01", milestone: null },
    ]);
    expect(rows.map((r) => [r.key, r.amountAgorot])).toEqual([
      ["a", 5001],
      ["b", 5000],
    ]);
  });

  it("percents as typed", () => {
    expect(parsePercentBp("30")).toBe(3000);
    expect(parsePercentBp("33.33")).toBe(3333);
    expect(parsePercentBp("12,5")).toBe(1250);
    expect(parsePercentBp("40%")).toBe(4000);
    expect(parsePercentBp("0.001")).toBeNull();
    expect(parsePercentBp("abc")).toBeNull();
    expect(percentText(3333)).toBe("33.33%");
    expect(percentText(1250)).toBe("12.5%");
    expect(percentText(10000)).toBe("100%");
  });

  it("a step names a date or a milestone, and a percent between 0.01 and 100", () => {
    const parse = (v: Record<string, string>) => scheduleStepSchema.safeParse({ name: "מקדמה", percent: "30", due_date: "", milestone: "", ...v });
    expect(parse({}).success).toBe(false);
    expect(parse({ milestone: "בחתימה" }).success).toBe(true);
    expect(parse({ due_date: "2027-01-15" }).success).toBe(true);
    expect(parse({ due_date: "2027-02-30" }).success).toBe(false);
    expect(parse({ milestone: "x", percent: "0" }).success).toBe(false);
    expect(parse({ milestone: "x", percent: "100.01" }).success).toBe(false);
    expect(parse({ milestone: "x", name: " " }).success).toBe(false);
    const ok = parse({ milestone: "  בסיום  ", due_date: "" });
    expect(ok.success && ok.data).toEqual({ name: "מקדמה", percent: 3000, due_date: null, milestone: "בסיום" });
  });
});
