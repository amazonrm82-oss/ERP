import { describe, expect, it } from "vitest";

import { isActive, navItems } from "@/features/shell/nav";
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
});
