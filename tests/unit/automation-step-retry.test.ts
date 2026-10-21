import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MAX_STEP_RETRIES, retryLine } from "@/features/automations/describe";

// AUT-06: the run log's line about the retries of a run's failed steps, against the engine's rule.

const ENGINE = readFileSync(
  `supabase/migrations/${readdirSync("supabase/migrations").find((file) => file.endsWith("_automation_step_retry.sql"))}`,
  "utf8",
);

describe("retries of failed automation steps (AUT-06)", () => {
  it("the most retries and the end notes are the engine's", () => {
    expect(ENGINE).toContain(`retry_count between 0 and ${MAX_STEP_RETRIES}`);
    for (const note of ["rule_changed", "rule_off", "record_gone", "conditions", "error", "event_changed", "org_closed"]) {
      expect(ENGINE).toContain(`'${note}'`);
      expect(retryLine({ retryCount: 0, nextRetryAt: null, retryNote: note }, null)).toMatch(/^(לא ננסה שוב|לא רץ): /);
    }
    // the owner's wording, 21 October 2026
    expect(retryLine({ retryCount: 0, nextRetryAt: null, retryNote: "event_changed" }, null)).toBe("לא רץ: האירוע השתנה");
    expect(retryLine({ retryCount: 0, nextRetryAt: null, retryNote: "org_closed" }, null)).toBe("לא רץ: העסק סגור");
  });

  it("says when the next retry is, how many were made, or nothing", () => {
    expect(retryLine({ retryCount: 0, nextRetryAt: null, retryNote: null }, null)).toBeNull();
    expect(retryLine({ retryCount: 0, nextRetryAt: "2026-10-21T10:15:00Z", retryNote: null }, "21.10.2026, 13:15")).toBe(
      "הצעדים שנכשלו ינוסו שוב ב-21.10.2026, 13:15 (ניסיון חוזר 1 מתוך 3).",
    );
    expect(retryLine({ retryCount: 1, nextRetryAt: null, retryNote: null }, null)).toBe("הצעדים שנכשלו נוסו שוב פעם אחת.");
    expect(retryLine({ retryCount: 3, nextRetryAt: null, retryNote: null }, null)).toBe("הצעדים שנכשלו נוסו שוב 3 פעמים.");
    expect(retryLine({ retryCount: 0, nextRetryAt: null, retryNote: "unknown" }, null)).toBeNull();
  });
});
