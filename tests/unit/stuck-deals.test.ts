import { describe, expect, it } from "vitest";

import { stuckReason } from "@/features/deals/stuck";

describe("why a deal is stuck (DEAL-02)", () => {
  it("says what is missing, in words", () => {
    expect(stuckReason({ idle: true, idle_days: 20, no_next_step: false })).toBe("בלי פעילות 20 ימים");
    expect(stuckReason({ idle: false, idle_days: 2, no_next_step: true })).toBe("אין משימה פתוחה");
    expect(stuckReason({ idle: true, idle_days: 1, no_next_step: true })).toBe("בלי פעילות יום אחד · אין משימה פתוחה");
  });
});
