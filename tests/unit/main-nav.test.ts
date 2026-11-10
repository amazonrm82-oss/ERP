import { describe, expect, it } from "vitest";

import { DEFAULT_MODULES, withOrdersPlan } from "@/features/modules/modules";
import { orderPath, ordersPath } from "@/features/orders/paths";
import { createItems, isActive, navCountText, navItems } from "@/features/shell/nav";
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

  it("SPD-01: the waiting leads have their own entry after the leads, under 'עוד', with a capped counter", () => {
    const items = navItems(ORG);
    const waiting = items.find((entry) => entry.key === "waiting")!;
    expect(waiting).toMatchObject({ label: "לידים שמחכים", href: `/o/${ORG}/leads/waiting?who=all`, mobile: false });
    expect(items.indexOf(waiting)).toBe(items.findIndex((entry) => entry.key === "leads") + 1);
    // the waiting screen lights its own entry, not the leads entry; a lead's page still lights the leads entry
    const leads = items.find((entry) => entry.key === "leads")!;
    expect(isActive(`/o/${ORG}/leads/waiting`, waiting)).toBe(true);
    expect(isActive(`/o/${ORG}/leads/waiting`, leads)).toBe(false);
    expect(isActive(`/o/${ORG}/leads/22222222-2222-4222-8222-222222222222`, leads)).toBe(true);
    expect(isActive(`/o/${ORG}/leads/22222222-2222-4222-8222-222222222222`, waiting)).toBe(false);
    // owner (190) ב: a viewer takes no lead, so the entry leaves a viewer's menu (the bottom bar keeps its places)
    expect(navItems(ORG, undefined, undefined, { viewer: true }).map((entry) => entry.key)).not.toContain("waiting");
    expect(navItems(ORG, undefined, undefined, { viewer: true }).filter((entry) => entry.mobile).map((entry) => entry.key)).toEqual(["home", "leads", "deals", "tasks"]);
    // LEAD-08: leads switched off take the entry with them
    expect(navItems(ORG, undefined, { ...DEFAULT_MODULES, leads: false }).map((entry) => entry.key)).not.toContain("waiting");
    expect([navCountText(null), navCountText(0), navCountText(-1), navCountText(Number.NaN)]).toEqual([null, null, null, null]);
    expect([navCountText(1), navCountText(99), navCountText(100)]).toEqual(["1", "99", "99+"]);
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
