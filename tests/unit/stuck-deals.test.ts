import { describe, expect, it } from "vitest";

import { lastActivityText, stuckReason } from "@/features/deals/stuck-text";
import { formatDate } from "@/lib/format";

const fmt = (n: number) => String(n);
const base = { stuck: false, days_in_stage: 3, limit_days: 14, last_activity_at: null, idle_days: 3, no_next_step: false };

describe("why a deal needs attention (DEAL-01, time in stage)", () => {
  it("a stuck deal says how long it has been in the stage and the stage's limit", () => {
    expect(stuckReason({ ...base, stuck: true, days_in_stage: 20, last_activity_at: "2026-10-01T00:00:00Z", idle_days: 12 }, fmt)).toBe(
      "20 ימים בשלב (מעל 14) · פעילות אחרונה לפני 12 ימים",
    );
  });

  it("no next step is said on its own, and every row says when the last activity was", () => {
    expect(stuckReason({ ...base, no_next_step: true }, fmt)).toBe("אין משימה או פגישה · אין פעילות");
    expect(stuckReason({ ...base, stuck: true, days_in_stage: 15, no_next_step: true, last_activity_at: "x", idle_days: 1 }, fmt)).toBe(
      "15 ימים בשלב (מעל 14) · אין משימה או פגישה · פעילות אחרונה לפני יום אחד",
    );
  });

  it("a postponed deal says until when", () => {
    expect(stuckReason({ ...base, postponed: true, snoozed_until: "2026-11-02", days_in_stage: 30, last_activity_at: "x", idle_days: 2 }, fmt)).toBe(
      `נדחתה עד ${formatDate("2026-11-02")} · פעילות אחרונה לפני 2 ימים`,
    );
  });

  it("last activity in words", () => {
    expect(lastActivityText({ last_activity_at: null, idle_days: 9 }, fmt)).toBe("אין פעילות");
    expect(lastActivityText({ last_activity_at: "x", idle_days: 0 }, fmt)).toBe("פעילות אחרונה היום");
    expect(lastActivityText({ last_activity_at: "x", idle_days: 1 }, fmt)).toBe("פעילות אחרונה לפני יום אחד");
    expect(lastActivityText({ last_activity_at: "x", idle_days: 7 }, fmt)).toBe("פעילות אחרונה לפני 7 ימים");
  });
});
