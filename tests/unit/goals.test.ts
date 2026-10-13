import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  GOAL_METRIC_KEYS,
  GOAL_METRICS,
  GOAL_PERIODS,
  addMonths,
  goalMetric,
  isGoalMetric,
  monthStart,
  parseTarget,
  periodStartOf,
  targetText,
} from "@/features/goals/metrics";
import { ENTITY_LABELS, FIELD_LABELS, VALUE_LABELS } from "@/features/audit/labels";
import { EXPORT_README, EXPORT_TABLES } from "@/features/imports/export-build";

// GOL-01
describe("goal metrics", () => {
  it("the lists match the migration's check constraints", () => {
    const sql = readFileSync(path.resolve(__dirname, "../../supabase/migrations/20261006013300_goals.sql"), "utf8");
    const list = (name: string) => [...(new RegExp(`constraint ${name} check \\(\\w+ in \\(([^)]*)\\)\\)`).exec(sql)?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(list("goals_metric_check")).toEqual(GOAL_METRIC_KEYS);
    expect(list("goals_period_check")).toEqual([...GOAL_PERIODS]);
    expect(sql).toContain("check (target between 0 and 100000000000)");
  });

  it("every metric has a Hebrew label and a kind; only revenue is money", () => {
    for (const metric of GOAL_METRICS) {
      expect(metric.label).toMatch(/[א-ת]/);
      expect(metric.description).toMatch(/[א-ת]/);
    }
    expect(GOAL_METRICS.filter((m) => m.kind === "money").map((m) => m.key)).toEqual(["won_amount"]);
    expect(isGoalMetric("won_deals")).toBe(true);
    expect(isGoalMetric("collections")).toBe(false);
    expect(goalMetric("meetings_held").kind).toBe("count");
  });

  it("targets: shekels to agorot for money, whole numbers for counts, empty for none", () => {
    expect(parseTarget("money", "")).toEqual({ ok: true, value: null });
    expect(parseTarget("money", "  ")).toEqual({ ok: true, value: null });
    expect(parseTarget("money", "50,000")).toEqual({ ok: true, value: 5_000_000 });
    expect(parseTarget("money", "₪ 1234.5")).toEqual({ ok: true, value: 123_450 });
    expect(parseTarget("money", "12.345").ok).toBe(false);
    expect(parseTarget("money", "-5").ok).toBe(false);
    expect(parseTarget("money", "abc").ok).toBe(false);
    expect(parseTarget("money", "1000000001").ok).toBe(false);
    expect(parseTarget("money", "1000000000")).toEqual({ ok: true, value: 100_000_000_000 });
    expect(parseTarget("count", "12")).toEqual({ ok: true, value: 12 });
    expect(parseTarget("count", "1.5").ok).toBe(false);
    expect(parseTarget("count", "0")).toEqual({ ok: true, value: 0 });
    expect(targetText("money", 5_000_000)).toBe("50000");
    expect(targetText("money", 123_450)).toBe("1234.50");
    expect(targetText("count", 7)).toBe("7");
    expect(targetText("count", null)).toBe("");
    // what a cell shows parses back to the same value
    for (const value of [0, 1, 99, 100, 123_456_789]) {
      expect(parseTarget("money", targetText("money", value))).toEqual({ ok: true, value });
    }
  });

  it("months and period starts", () => {
    expect(monthStart("2026-10")).toBe("2026-10-01");
    expect(monthStart("2026-13")).toBeNull();
    expect(monthStart("1999-12")).toBeNull();
    expect(monthStart("2026-1")).toBeNull();
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-11", 3)).toBe("2027-02");
    expect(addMonths("2026-10", 0)).toBe("2026-10");
    expect(periodStartOf("quarter", "2026-11-01")).toBe("2026-10-01");
    expect(periodStartOf("quarter", "2026-03-01")).toBe("2026-01-01");
    expect(periodStartOf("year", "2026-11-01")).toBe("2026-01-01");
    expect(periodStartOf("month", "2026-11-01")).toBe("2026-11-01");
  });

  it("goals are in the full export, with a line in the read-me", () => {
    expect(EXPORT_TABLES.find((t) => t.table === "goals")?.file).toBe("goals.csv");
    expect(EXPORT_README).toContain("goals.csv");
  });

  it("the audit log names goals, their fields and their coded values in Hebrew", () => {
    expect(ENTITY_LABELS.goals).toBe("יעד");
    for (const field of ["scope", "user_id", "team_id", "period", "period_start", "metric", "target"]) {
      expect(FIELD_LABELS[field], field).toMatch(/[א-ת]/);
    }
    expect(Object.keys(VALUE_LABELS.metric)).toEqual(GOAL_METRIC_KEYS);
    expect(Object.keys(VALUE_LABELS.period)).toEqual([...GOAL_PERIODS]);
    expect(Object.keys(VALUE_LABELS.scope)).toEqual(["user", "team", "org"]);
    expect(VALUE_LABELS.metric.won_amount).toBe("הכנסה שנסגרה");
  });
});
