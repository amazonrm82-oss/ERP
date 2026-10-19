import { describe, expect, it } from "vitest";

import { cancelledQuoteFrom, publicQuoteFrom } from "@/features/quotes/public";

// QUO-11: the customer's link of an accepted quote that was cancelled carries only number, title and business
describe("the cancelled answer of the customer's page (QUO-11)", () => {
  const answer = { cancelled: { number: "Q-1001", title: "שיפוץ", business: "עסק", logo: null, color: "#112233" } };

  it("reads the cancelled shape, and only it", () => {
    expect(cancelledQuoteFrom(answer)).toEqual({ cancelled: true, number: "Q-1001", title: "שיפוץ", business: "עסק", logoPath: null });
    expect(publicQuoteFrom(answer)).toBeNull();
    expect(cancelledQuoteFrom({ quote: { title: "x" } })).toBeNull();
    expect(cancelledQuoteFrom({ cancelled: { title: "x" } })).toBeNull();
    expect(cancelledQuoteFrom(null)).toBeNull();
  });
});
