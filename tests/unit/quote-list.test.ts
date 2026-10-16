import { describe, expect, it } from "vitest";

import { quoteListFilters, quoteListHref } from "@/features/quotes/list";

// QUO-16: the filters of the quotes list come from the address; anything not valid is left out.

const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";

describe("the quotes list filters (QUO-16)", () => {
  it("reads valid filters and drops the rest", () => {
    expect(quoteListFilters({ status: "sent", owner: USER, from: "2026-10-01", to: "2026-10-31", page: "2" })).toEqual({
      status: "sent",
      ownerId: USER,
      from: "2026-10-01",
      to: "2026-10-31",
      page: 2,
    });
    expect(quoteListFilters({ status: "won", owner: "x", from: "2026-02-30", to: "yesterday", page: "-1" })).toEqual({
      status: null,
      ownerId: null,
      from: null,
      to: null,
      page: 1,
    });
    expect(quoteListFilters({ status: ["draft", "sent"] }).status).toBe("draft");
  });

  it("a range typed backwards is read the right way round", () => {
    expect(quoteListFilters({ from: "2026-10-31", to: "2026-10-01" })).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
  });

  it("builds the address of a page with the same filters", () => {
    const filters = quoteListFilters({ status: "sent", owner: USER, from: "2026-10-01" });
    expect(quoteListHref(ORG, filters, 3)).toBe(`/o/${ORG}/quotes?status=sent&owner=${USER}&from=2026-10-01&page=3`);
    expect(quoteListHref(ORG, filters, 1)).toBe(`/o/${ORG}/quotes?status=sent&owner=${USER}&from=2026-10-01`);
    expect(quoteListHref(ORG, quoteListFilters({}))).toBe(`/o/${ORG}/quotes`);
  });
});
