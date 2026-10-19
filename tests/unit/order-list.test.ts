import { describe, expect, it } from "vitest";

import { isFiltered, orderListFilters, orderListHref } from "@/features/orders/list";

const OWNER = "11111111-1111-4111-8111-111111111111";

// ORD-06 part one: the orders list's filters come from the address and are checked, never trusted
describe("orders list filters (ORD-06)", () => {
  it("reads what is valid and leaves out the rest", () => {
    expect(orderListFilters({ status: "delivered", source: "quote", owner: OWNER, from: "2026-10-01", to: "2026-10-31", page: "2" })).toEqual({
      status: "delivered",
      source: "quote",
      ownerId: OWNER,
      from: "2026-10-01",
      to: "2026-10-31",
      page: 2,
    });
    expect(orderListFilters({ status: "paid", source: "x", owner: "not-a-uuid", from: "2026-13-01" })).toEqual({
      status: null,
      source: null,
      ownerId: null,
      from: null,
      to: null,
      page: 1,
    });
  });

  it("a range typed backwards is read the right way round", () => {
    const f = orderListFilters({ from: "2026-10-31", to: "2026-10-01" });
    expect([f.from, f.to]).toEqual(["2026-10-01", "2026-10-31"]);
  });

  it("the address keeps the filters and the page", () => {
    const f = orderListFilters({ status: "new", owner: OWNER });
    expect(isFiltered(f)).toBe(true);
    expect(orderListHref("org", f, 3)).toBe(`/o/org/orders?status=new&owner=${OWNER}&page=3`);
    expect(orderListHref("org", orderListFilters({}))).toBe("/o/org/orders");
    expect(isFiltered(orderListFilters({}))).toBe(false);
  });
});
