import { describe, expect, it } from "vitest";

import { publicQuoteFrom, STATUS_PAGE_STATES, STATUS_PAGE_TEXT, statusQuoteFrom } from "@/features/quotes/public";

// QUO-11, and the owner's rule of 19 October 2026: a link whose newest sent version is not open (a cancelled accepted quote
// among them) shows a status page: number, title, business and phone, never prices or lines
describe("the status answer of the customer's page", () => {
  const answer = {
    status_page: {
      state: "cancelled",
      number: "Q-1001",
      title: "שיפוץ",
      valid_until: null,
      business: "עסק",
      logo: null,
      color: "#112233",
      phone: "03-5555555",
      replaced: null,
      draft_version: false,
    },
  };

  it("reads the status shape, and only it", () => {
    expect(statusQuoteFrom(answer)).toEqual({
      statusPage: true,
      state: "cancelled",
      number: "Q-1001",
      title: "שיפוץ",
      validUntil: null,
      business: "עסק",
      logoPath: null,
      phone: "03-5555555",
      replaced: null,
      draftVersion: false,
    });
    expect(publicQuoteFrom(answer)).toBeNull();
    expect(statusQuoteFrom({ quote: { title: "x" } })).toBeNull();
    expect(statusQuoteFrom({ status_page: { ...answer.status_page, state: "sent" } })).toBeNull();
    expect(statusQuoteFrom({ cancelled: { title: "x" } })).toBeNull();
    expect(statusQuoteFrom(null)).toBeNull();
    expect(statusQuoteFrom({ status_page: { ...answer.status_page, replaced: { number: "Q-1000" } } })!.replaced).toEqual({ number: "Q-1000" });
  });

  it("has a Hebrew sentence for every state", () => {
    for (const state of STATUS_PAGE_STATES) expect(STATUS_PAGE_TEXT[state]).toMatch(/[א-ת]/);
  });
});
