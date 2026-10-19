import { describe, expect, it } from "vitest";

import { notificationHref } from "@/features/notifications/links";
import { quoteViewsCount } from "@/features/quotes/views";

describe("quote views (QUO-10)", () => {
  it("says how many times the customer opened the quote", () => {
    const at = "2026-10-18T09:00:00Z";
    expect(quoteViewsCount(null)).toBeNull();
    expect(quoteViewsCount({ firstViewedAt: at, lastViewedAt: at, count: 1 })).toBe("נצפתה פעם אחת");
    expect(quoteViewsCount({ firstViewedAt: at, lastViewedAt: at, count: 3 })).toBe("נצפתה 3 פעמים");
    expect(quoteViewsCount({ firstViewedAt: at, lastViewedAt: at, count: 1200 })).toBe("נצפתה 1,200 פעמים");
  });

  it("a quote_viewed notification leads to the quote", () => {
    const org = "00000000-0000-4000-8000-000000000001";
    const id = "00000000-0000-4000-8000-000000000002";
    expect(notificationHref(org, "quote", id)).toBe(`/o/${org}/quotes/${id}`);
  });
});
