import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { runQuotaState, runQuotaStopAt } from "@/features/automations/run-quota";
import { STEP_ERRORS } from "@/features/automations/describe";

// AUT-07: the automations screen's bar uses the thresholds app.execute_automation uses.

const ENGINE = readFileSync(
  `supabase/migrations/${readdirSync("supabase/migrations").find((file) => file.endsWith("_automation_run_quota.sql"))}`,
  "utf8",
);

describe("monthly automation runs (AUT-07)", () => {
  it("uses the engine's thresholds: 80% (ceil), 100%, stop at 110% (floor)", () => {
    expect(ENGINE).toContain("v_quota.runs >= floor(v_limit * 1.1)");
    expect(ENGINE).toContain("v_runs >= ceil(v_limit * 0.8)");
    expect(ENGINE).toContain("v_runs >= v_limit");
    expect(runQuotaStopAt(1000)).toBe(1100);
    expect(runQuotaStopAt(15)).toBe(16);
  });

  it("shows nothing below 80% or without a limit, then warns, then says the runs stopped", () => {
    expect(runQuotaState(5, null)).toBeNull();
    expect(runQuotaState(799, 1000)).toBeNull();
    expect(runQuotaState(800, 1000)?.level).toBe("warn");
    expect(runQuotaState(1000, 1000)?.level).toBe("full");
    expect(runQuotaState(1099, 1000)?.level).toBe("full");
    expect(runQuotaState(1100, 1000)?.level).toBe("stopped");
    expect(runQuotaState(0, 0)?.level).toBe("stopped");
    expect(runQuotaState(800, 1000)?.text).toContain("800 מתוך 1,000");
  });

  it("the run log explains a run skipped at the stop", () => {
    expect(ENGINE).toContain("'the monthly automation runs of the plan are used up'");
    expect(STEP_ERRORS["the monthly automation runs of the plan are used up"]).toMatch(/נוצלו/);
  });
});
