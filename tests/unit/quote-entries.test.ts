import { describe, expect, it } from "vitest";

import { quoteEntryKind, quoteEntryText } from "@/features/activities/quote-entries";

// QUO-16: the timeline entries of a quote (app.quote_timeline_entry writes them; the screen words them).

describe("quote timeline entries", () => {
  it("knows sent (the sender's note, or a system entry with no person) and accepted / declined (system entries)", () => {
    expect(quoteEntryKind("note", "quote_sent")).toBe("quote_sent");
    expect(quoteEntryKind("system", "quote_sent")).toBe("quote_sent");
    expect(quoteEntryKind("system", "quote_accepted")).toBe("quote_accepted");
    expect(quoteEntryKind("system", "quote_rejected")).toBe("quote_rejected");
    // a person cannot make their own note look like a decision, and other entries are left alone
    expect(quoteEntryKind("note", "quote_accepted")).toBeNull();
    expect(quoteEntryKind("call", "quote_sent")).toBeNull();
    expect(quoteEntryKind("system", "snooze_cleared")).toBeNull();
    expect(quoteEntryKind("note", null)).toBeNull();
  });

  it("names the number and the title as the quote reads now, never an amount", () => {
    expect(quoteEntryText("quote_sent", "QT-7", "שיפוץ מטבח")).toBe('הצעת מחיר QT-7 "שיפוץ מטבח" נשלחה.');
    expect(quoteEntryText("quote_accepted", "QT-7", null)).toBe("הצעת מחיר QT-7 אושרה.");
    expect(quoteEntryText("quote_rejected", null, null)).toBe("הצעת מחיר נדחתה.");
  });
});
