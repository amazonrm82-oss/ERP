import { describe, expect, it } from "vitest";

import { DEFAULT_MODULES, withOrdersPlan } from "@/features/modules/modules";
import { orderPath, ordersPath } from "@/features/orders/paths";
import { createItems, isActive, navItems } from "@/features/shell/nav";
import { quotePath, quotesPath } from "@/features/quotes/paths";

const ORG = "11111111-1111-4111-8111-111111111111";

describe("main menu", () => {
  it("QUO-16: quotes have their own entry, under 'עוד' on a phone", () => {
    const item = navItems(ORG).find((entry) => entry.key === "quotes");
    expect(item).toMatchObject({ label: "הצעות מחיר", href: quotesPath(ORG), mobile: false });
    expect(isActive(quotePath(ORG, "22222222-2222-4222-8222-222222222222"), item!)).toBe(true);
    // the deals entry does not light up on the quotes list
    const deals = navItems(ORG).find((entry) => entry.key === "deals")!;
    expect(isActive(quotesPath(ORG), deals)).toBe(false);
  });

  it("the phone bottom bar keeps its four places", () => {
    expect(navItems(ORG).filter((entry) => entry.mobile).map((entry) => entry.key)).toEqual(["home", "leads", "deals", "tasks"]);
  });

  it("keys and links are unique", () => {
    const items = navItems(ORG);
    expect(new Set(items.map((entry) => entry.key)).size).toBe(items.length);
    expect(new Set(items.map((entry) => entry.href)).size).toBe(items.length);
  });

  it("ORD-01: orders show only while the plan holds them and the business switched them on, after quotes, under 'עוד'", () => {
    const keys = (modules: typeof DEFAULT_MODULES) => navItems(ORG, undefined, modules).map((entry) => entry.key);
    const stored = { ...DEFAULT_MODULES, orders: true };
    // off by default, and either half alone is not enough
    expect(keys(DEFAULT_MODULES)).not.toContain("orders");
    expect(keys(withOrdersPlan(DEFAULT_MODULES, true))).not.toContain("orders");
    expect(keys(withOrdersPlan(stored, false))).not.toContain("orders");
    const on = withOrdersPlan(stored, true);
    expect(on.orders).toBe(true);
    const all = keys(on);
    expect(all.indexOf("orders")).toBe(all.indexOf("quotes") + 1);
    const item = navItems(ORG, undefined, on).find((entry) => entry.key === "orders");
    expect(item).toMatchObject({ label: "הזמנות", href: ordersPath(ORG), mobile: false });
    expect(isActive(orderPath(ORG, "22222222-2222-4222-8222-222222222222"), item!)).toBe(true);
    // the bottom bar keeps its four places, entries stay unique, and "+" has no order entry (orders are made from a record)
    expect(navItems(ORG, undefined, on).filter((entry) => entry.mobile).map((entry) => entry.key)).toEqual(["home", "leads", "deals", "tasks"]);
    const items = navItems(ORG, undefined, on);
    expect(new Set(items.map((entry) => entry.href)).size).toBe(items.length);
    expect(createItems(ORG, undefined, on).map((entry) => entry.key)).toEqual(createItems(ORG).map((entry) => entry.key));
  });
});
