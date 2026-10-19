import { describe, expect, it } from "vitest";

import { quoteEndsSoonText, quoteWaitText, withoutSupersededQuotes } from "@/features/home/my-day";

const ZONE = "Asia/Jerusalem";

// TASK-09: quotes that wait for the customer's answer in My day
describe("my day: quotes waiting for an answer (TASK-09)", () => {
  it("says how long the quote has waited, in the business's days, and whether the customer opened it", () => {
    expect(quoteWaitText({ status: "sent", sentAt: "2026-10-19T06:00:00Z" }, "2026-10-19", ZONE)).toBe("נשלחה היום");
    expect(quoteWaitText({ status: "viewed", sentAt: "2026-10-18T06:00:00Z" }, "2026-10-19", ZONE)).toBe("נשלחה אתמול, נצפתה");
    expect(quoteWaitText({ status: "sent", sentAt: "2026-10-14T06:00:00Z" }, "2026-10-19", ZONE)).toBe("נשלחה לפני 5 ימים");
    // 22:30 UTC on the 18th is already the 19th in Israel
    expect(quoteWaitText({ status: "sent", sentAt: "2026-10-18T22:30:00Z" }, "2026-10-19", ZONE)).toBe("נשלחה היום");
    expect(quoteWaitText({ status: "sent", sentAt: null }, "2026-10-19", ZONE)).toBe("נשלחה");
  });

  it("warns on the last day and the day before it only", () => {
    expect(quoteEndsSoonText("2026-10-19", "2026-10-19")).toBe("בתוקף עד היום");
    expect(quoteEndsSoonText("2026-10-20", "2026-10-19")).toBe("בתוקף עד מחר");
    expect(quoteEndsSoonText("2026-10-25", "2026-10-19")).toBeNull();
    expect(quoteEndsSoonText("2026-10-18", "2026-10-19")).toBeNull();
    expect(quoteEndsSoonText(null, "2026-10-19")).toBeNull();
  });

  it("leaves out a quote whose newer version was sent", () => {
    expect(withoutSupersededQuotes([{ id: "a" }, { id: "b" }], new Set(["a"]))).toEqual([{ id: "b" }]);
  });
});
